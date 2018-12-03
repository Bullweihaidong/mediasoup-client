import Logger from '../../lib/Logger';
import EnhancedEventEmitter from '../../lib/EnhancedEventEmitter';
import * as utils from '../../lib/utils';
import * as ortc from '../../lib/ortc';

const logger = new Logger('FakeHandler');
let localNativeRtpCapabilities;
let localDtlsParameters;

export default class FakeHandler extends EnhancedEventEmitter
{
	static setLocalNativeRtpCapabilities(rtpCapabilities)
	{
		localNativeRtpCapabilities = rtpCapabilities;
	}

	static setLocalDtlsParameters(dtlsParameters)
	{
		localDtlsParameters = dtlsParameters;
	}

	static getNativeRtpCapabilities()
	{
		logger.debug('getNativeRtpCapabilities()');

		return Promise.resolve(localNativeRtpCapabilities);
	}

	constructor(
		{
			remoteTransportData, // eslint-disable-line no-unused-vars
			direction,
			turnServers, // eslint-disable-line no-unused-vars
			iceTransportPolicy, // eslint-disable-line no-unused-vars
			extendedRtpCapabilities
		}
	)
	{
		super(logger);

		logger.debug('constructor() [direction:%s]', direction);

		// Generic sending RTP parameters for audio and video.
		// @type {Object}
		this._rtpParametersByKind =
		{
			audio : ortc.getSendingRtpParameters('audio', extendedRtpCapabilities),
			video : ortc.getSendingRtpParameters('video', extendedRtpCapabilities)
		};

		// Local RTCP CNAME.
		// @type {String}
		this._cname = `CNAME-${utils.generateRandomNumber()}`;

		// Got transport local and remote parameters.
		// @type {Boolean}
		this._transportReady = false;
	}

	close()
	{
		logger.debug('close()');
	}

	send({ track, simulcast }) // eslint-disable-line no-unused-vars
	{
		logger.debug('send() [kind:%s, trackId:%s]', track.kind, track.id);

		return Promise.resolve()
			.then(() =>
			{
				if (!this._transportReady)
					return this._setupTransport({ localDtlsRole: 'client' });
			})
			.then(() =>
			{
				const rtpParameters =
					utils.clone(this._rtpParametersByKind[track.kind]);

				// Fill RTCRtpParameters.encodings.
				const encoding =
				{
					ssrc : utils.generateRandomNumber()
				};

				if (rtpParameters.codecs.some((codec) => codec.name === 'rtx'))
				{
					encoding.rtx =
					{
						ssrc : utils.generateRandomNumber()
					};
				}

				rtpParameters.encodings.push(encoding);

				// Fill RTCRtpParameters.rtcp.
				rtpParameters.rtcp =
				{
					cname       : this._cname,
					reducedSize : true,
					mux         : true
				};

				return rtpParameters;
			});
	}

	stopSending({ track })
	{
		logger.debug('stopSending() [trackId:%s]', track.id);
	}

	replaceTrack({ track, newTrack }) // eslint-disable-line no-unused-vars
	{
		logger.debug('replaceTrack() [newTrackId:%s]', newTrack);

		return Promise.resolve(newTrack);
	}

	_setupTransport({ localDtlsRole } = {})
	{
		return Promise.resolve()
			.then(() =>
			{
				const dtlsParameters = utils.clone(localDtlsParameters);

				// Set our DTLS role.
				if (localDtlsRole)
					dtlsParameters.role = localDtlsRole;

				const transportLocalParameters = { dtlsParameters };

				// Need to tell the remote transport about our parameters.
				return this.safeEmitAsPromise(
					'@localparameters', transportLocalParameters);
			})
			.then(() =>
			{
				this._transportReady = true;
			});
	}
}