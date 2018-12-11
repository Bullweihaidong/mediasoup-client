const sdpTransform = require('sdp-transform');
const Logger = require('../Logger');
const EnhancedEventEmitter = require('../EnhancedEventEmitter');
const { UnsupportedError, DuplicatedError } = require('../errors');
const utils = require('../utils');
const ortc = require('../ortc');
const sdpCommonUtils = require('./sdp/commonUtils');
const sdpPlanBUtils = require('./sdp/planBUtils');
const RemotePlanBSdp = require('./sdp/RemotePlanBSdp');

const logger = new Logger('Chrome55');

class Handler extends EnhancedEventEmitter
{
	constructor(
		{
			transportRemoteParameters,
			direction,
			iceServers,
			iceTransportPolicy,
			proprietaryConstraints,
			rtpParametersByKind
		}
	)
	{
		super(logger);

		// Generic sending RTP parameters for audio and video.
		// @type {Object}
		this._rtpParametersByKind = rtpParametersByKind;

		// Got transport local and remote parameters.
		// @type {Boolean}
		this._transportReady = false;

		// Remote SDP handler.
		// @type {RemotePlanBSdp}
		this._remoteSdp = new RemotePlanBSdp(direction, rtpParametersByKind);

		this._remoteSdp.setTransportRemoteParameters(transportRemoteParameters);

		// RTCPeerConnection instance.
		// @type {RTCPeerConnection}
		this._pc = new RTCPeerConnection(
			{
				iceServers         : iceServers || [],
				iceTransportPolicy : iceTransportPolicy || 'all',
				bundlePolicy       : 'max-bundle',
				rtcpMuxPolicy      : 'require',
				sdpSemantics       : 'plan-b'
			},
			proprietaryConstraints);

		// Handle RTCPeerConnection connection status.
		this._pc.addEventListener('iceconnectionstatechange', () =>
		{
			switch (this._pc.iceConnectionState)
			{
				case 'checking':
					this.emit('@connectionstatechange', 'connecting');
					break;
				case 'connected':
				case 'completed':
					this.emit('@connectionstatechange', 'connected');
					break;
				case 'failed':
					this.emit('@connectionstatechange', 'failed');
					break;
				case 'disconnected':
					this.emit('@connectionstatechange', 'disconnected');
					break;
				case 'closed':
					this.emit('@connectionstatechange', 'closed');
					break;
			}
		});
	}

	close()
	{
		logger.debug('close()');

		// Close RTCPeerConnection.
		try { this._pc.close(); }
		catch (error) {}
	}

	getTransportStats()
	{
		return this._pc.getStats();
	}

	updateIceServers({ iceServers })
	{
		logger.debug('updateIceServers()');

		return Promise.resolve()
			.then(() =>
			{
				const configuration = this._pc.getConfiguration();

				configuration.iceServers = iceServers;

				this._pc.setConfiguration(configuration);
			});
	}

	_setupTransport({ localDtlsRole } = {})
	{
		return Promise.resolve()
			.then(() =>
			{
				// Get our local DTLS parameters.
				const sdp = this._pc.localDescription.sdp;
				const sdpObj = sdpTransform.parse(sdp);
				const dtlsParameters = sdpCommonUtils.extractDtlsParameters(sdpObj);

				// Set our DTLS role.
				if (localDtlsRole)
					dtlsParameters.role = localDtlsRole;

				const transportLocalParameters = { dtlsParameters };

				// Need to tell the remote transport about our parameters.
				return this.safeEmitAsPromise('@connect', transportLocalParameters);
			})
			.then(() =>
			{
				this._transportReady = true;
			});
	}
}

class SendHandler extends Handler
{
	constructor(data)
	{
		super(data);

		// Local stream.
		// @type {MediaStream}
		this._stream = new MediaStream();
	}

	send({ track, simulcast })
	{
		logger.debug('send() [kind:%s, track.id:%s]', track.kind, track.id);

		if (this._stream.getTrackById(track.id))
			return Promise.reject(new DuplicatedError('track already added'));

		let localSdpObj;

		return Promise.resolve()
			.then(() =>
			{
				// Add the track to the local stream.
				this._stream.addTrack(track);

				// Add the stream to the PeerConnection.
				this._pc.addStream(this._stream);

				return this._pc.createOffer();
			})
			.then((offer) =>
			{
				// If simulcast is set, mangle the offer.
				if (simulcast)
				{
					logger.debug('send() | enabling simulcast');

					const sdpObject = sdpTransform.parse(offer.sdp);

					sdpPlanBUtils.addSimulcastForTrack(
						sdpObject,
						track,
						{ numStreams: Object.keys(simulcast).length });

					const offerSdp = sdpTransform.write(sdpObject);

					offer = { type: 'offer', sdp: offerSdp };
				}

				logger.debug(
					'send() | calling pc.setLocalDescription() [offer:%o]',
					offer);

				return this._pc.setLocalDescription(offer);
			})
			.then(() =>
			{
				if (!this._transportReady)
					return this._setupTransport({ localDtlsRole: 'server' });
			})
			.then(() =>
			{
				localSdpObj = sdpTransform.parse(this._pc.localDescription.sdp);

				const remoteSdp = this._remoteSdp.createAnswerSdp(localSdpObj);
				const answer = { type: 'answer', sdp: remoteSdp };

				logger.debug(
					'send() | calling pc.setRemoteDescription() [answer:%o]',
					answer);

				return this._pc.setRemoteDescription(answer);
			})
			.then(() =>
			{
				const rtpParameters =
					utils.clone(this._rtpParametersByKind[track.kind]);

				// Fill the RTP parameters for this track.
				sdpPlanBUtils.fillRtpParametersForTrack(
					rtpParameters, localSdpObj, track);

				return rtpParameters;
			})
			.catch((error) =>
			{
				// Panic here. Try to undo things.

				this._stream.removeTrack(track);
				this._pc.addStream(this._stream);

				throw error;
			});
	}

	stopSending({ track })
	{
		logger.debug('stopSending() [track.id:%s]', track.id);

		return Promise.resolve()
			.then(() =>
			{
				// Remove the track from the local stream.
				this._stream.removeTrack(track);

				// Add the stream to the PeerConnection.
				this._pc.addStream(this._stream);

				return this._pc.createOffer();
			})
			.then((offer) =>
			{
				logger.debug(
					'stopSending() | calling pc.setLocalDescription() [offer:%o]',
					offer);

				return this._pc.setLocalDescription(offer);
			})
			.catch((error) =>
			{
				// NOTE: If there are no sending tracks, setLocalDescription() will fail with
				// "Failed to create channels". If so, ignore it.
				if (this._stream.getTracks().length === 0)
				{
					logger.warn(
						'stopSending() | ignoring expected error due no sending tracks: %s',
						error.toString());

					return;
				}

				throw error;
			})
			.then(() =>
			{
				if (this._pc.signalingState === 'stable')
					return;

				const localSdpObj = sdpTransform.parse(this._pc.localDescription.sdp);
				const remoteSdp = this._remoteSdp.createAnswerSdp(localSdpObj);
				const answer = { type: 'answer', sdp: remoteSdp };

				logger.debug(
					'stopSending() | calling pc.setRemoteDescription() [answer:%o]',
					answer);

				return this._pc.setRemoteDescription(answer);
			});
	}

	replaceTrack({ track, newTrack }) // eslint-disable-line no-unused-vars
	{
		logger.debug('replaceTrack() [newTrack.id:%s]', newTrack.id);

		return Promise.reject(
			new UnsupportedError('not implemented in this device'));
	}

	getSenderStats({ track }) // eslint-disable-line no-unused-vars
	{
		return Promise.reject(
			new UnsupportedError('not implemented in this device'));
	}

	restartIce({ remoteIceParameters })
	{
		logger.debug('restartIce()');

		// Provide the remote SDP handler with new remote ICE parameters.
		this._remoteSdp
			.updateTransportRemoteIceParameters(remoteIceParameters);

		if (!this._transportReady)
			return Promise.resolve();

		return Promise.resolve()
			.then(() => this._pc.createOffer({ iceRestart: true }))
			.then((offer) =>
			{
				logger.debug(
					'restartIce() | calling pc.setLocalDescription() [offer:%o]',
					offer);

				return this._pc.setLocalDescription(offer);
			})
			.then(() =>
			{
				const localSdpObj = sdpTransform.parse(this._pc.localDescription.sdp);
				const remoteSdp = this._remoteSdp.createAnswerSdp(localSdpObj);
				const answer = { type: 'answer', sdp: remoteSdp };

				logger.debug(
					'restartIce() | calling pc.setRemoteDescription() [answer:%o]',
					answer);

				return this._pc.setRemoteDescription(answer);
			});
	}
}

class RecvHandler extends Handler
{
	constructor(data)
	{
		super(data);

		// Seen media kinds.
		// @type {Set<String>}
		this._kinds = new Set();

		// Map of receivers information indexed by id.
		// - kind {String}
		// - trackId {String}
		// - ssrc {Number}
		// - rtxSsrc {Number}
		// - cname {String}
		// @type {Map<String, Object>}
		this._receiverInfos = new Map();
	}

	receive({ id, kind, rtpParameters })
	{
		logger.debug('receive() [id:%s, kind:%s]', id, kind);

		if (this._receiverInfos.has(id))
			return Promise.reject(new DuplicatedError('already receiving this source'));

		const encoding = rtpParameters.encodings[0];
		const cname = rtpParameters.rtcp.cname;
		const receiverInfo =
		{
			kind     : kind,
			streamId : id,
			trackId  : `${kind}-${id}`,
			ssrc     : encoding.ssrc,
			cname    : cname
		};

		if (encoding.rtx && encoding.rtx.ssrc)
			receiverInfo.rtxSsrc = encoding.rtx.ssrc;

		this._receiverInfos.set(id, receiverInfo);
		this._kinds.add(kind);

		return Promise.resolve()
			.then(() =>
			{
				const remoteSdp = this._remoteSdp.createOfferSdp(
					Array.from(this._kinds), Array.from(this._receiverInfos.values()));
				const offer = { type: 'offer', sdp: remoteSdp };

				logger.debug(
					'receive() | calling pc.setRemoteDescription() [offer:%o]',
					offer);

				return this._pc.setRemoteDescription(offer);
			})
			.catch((error) =>
			{
				// Panic here. Try to undo things.

				this._receiverInfos.delete(id);

				throw error;
			})
			.then(() => this._pc.createAnswer())
			.then((answer) =>
			{
				logger.debug(
					'receive() | calling pc.setLocalDescription() [answer:%o]',
					answer);

				return this._pc.setLocalDescription(answer);
			})
			.then(() =>
			{
				if (!this._transportUpdated)
					return this._setupTransport({ localDtlsRole: 'client' });
			})
			.then(() =>
			{
				const stream = this._pc.getRemoteStreams()
					.find((s) => s.id === receiverInfo.streamId);
				const track = stream.getTrackById(receiverInfo.trackId);

				if (!track)
					throw new Error('remote track not found');

				return track;
			});
	}

	stopReceiving({ id })
	{
		logger.debug('stopReceiving() [id:%s]', id);

		if (!this._receiverInfos.has(id))
			return Promise.reject(new Error('source not found'));

		this._receiverInfos.delete(id);

		return Promise.resolve()
			.then(() =>
			{
				const remoteSdp = this._remoteSdp.createOfferSdp(
					Array.from(this._kinds), Array.from(this._receiverInfos.values()));
				const offer = { type: 'offer', sdp: remoteSdp };

				logger.debug(
					'stopReceiving() | calling pc.setRemoteDescription() [offer:%o]',
					offer);

				return this._pc.setRemoteDescription(offer);
			})
			.then(() => this._pc.createAnswer())
			.then((answer) =>
			{
				logger.debug(
					'stopReceiving() | calling pc.setLocalDescription() [answer:%o]',
					answer);

				return this._pc.setLocalDescription(answer);
			});
	}

	getReceiverStats({ track }) // eslint-disable-line no-unused-vars
	{
		return Promise.reject(
			new UnsupportedError('not implemented in this device'));
	}

	restartIce({ remoteIceParameters })
	{
		logger.debug('restartIce()');

		// Provide the remote SDP handler with new remote ICE parameters.
		this._remoteSdp
			.updateTransportRemoteIceParameters(remoteIceParameters);

		if (!this._transportReady)
			return Promise.resolve();

		return Promise.resolve()
			.then(() =>
			{
				const remoteSdp = this._remoteSdp.createOfferSdp(
					Array.from(this._kinds), Array.from(this._receiverInfos.values()));
				const offer = { type: 'offer', sdp: remoteSdp };

				logger.debug(
					'restartIce() | calling pc.setRemoteDescription() [offer:%o]',
					offer);

				return this._pc.setRemoteDescription(offer);
			})
			.then(() => this._pc.createAnswer())
			.then((answer) =>
			{
				logger.debug(
					'restartIce() | calling pc.setLocalDescription() [answer:%o]',
					answer);

				return this._pc.setLocalDescription(answer);
			});
	}
}

class Chrome55
{
	static getNativeRtpCapabilities()
	{
		logger.debug('getNativeRtpCapabilities()');

		const pc = new RTCPeerConnection(
			{
				iceServers         : [],
				iceTransportPolicy : 'all',
				bundlePolicy       : 'max-bundle',
				rtcpMuxPolicy      : 'require',
				sdpSemantics       : 'plan-b'
			});

		return pc.createOffer(
			{
				offerToReceiveAudio : true,
				offerToReceiveVideo : true
			})
			.then((offer) =>
			{
				try { pc.close(); }
				catch (error) {}

				const sdpObj = sdpTransform.parse(offer.sdp);
				const nativeRtpCapabilities =
					sdpCommonUtils.extractRtpCapabilities(sdpObj);

				return nativeRtpCapabilities;
			})
			.catch((error) =>
			{
				try { pc.close(); }
				catch (error2) {}

				throw error;
			});
	}

	constructor(
		{
			transportRemoteParameters,
			direction,
			iceServers,
			iceTransportPolicy,
			proprietaryConstraints,
			extendedRtpCapabilities
		}
	)
	{
		logger.debug('constructor() [direction:%s]', direction);

		switch (direction)
		{
			case 'send':
			{
				const rtpParametersByKind =
				{
					audio : ortc.getSendingRtpParameters('audio', extendedRtpCapabilities),
					video : ortc.getSendingRtpParameters('video', extendedRtpCapabilities)
				};

				return new SendHandler(
					{
						transportRemoteParameters,
						direction,
						iceServers,
						iceTransportPolicy,
						proprietaryConstraints,
						rtpParametersByKind
					});
			}
			case 'recv':
			{
				const rtpParametersByKind =
				{
					audio : ortc.getReceivingFullRtpParameters('audio', extendedRtpCapabilities),
					video : ortc.getReceivingFullRtpParameters('video', extendedRtpCapabilities)
				};

				return new RecvHandler(
					{
						transportRemoteParameters,
						direction,
						iceServers,
						iceTransportPolicy,
						proprietaryConstraints,
						rtpParametersByKind
					});
			}
		}
	}
}

module.exports = Chrome55;
