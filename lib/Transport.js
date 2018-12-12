const Logger = require('./Logger');
const EnhancedEventEmitter = require('./EnhancedEventEmitter');
const utils = require('./utils');
const ortc = require('./ortc');
const { UnsupportedError, InvalidStateError } = require('./errors');
const CommandQueue = require('./CommandQueue');
const Producer = require('./Producer');
const Consumer = require('./Consumer');

const SIMULCAST_DEFAULT =
{
	low    : 100000,
	medium : 500000,
	high   : 1500000
};

const logger = new Logger('Transport');

class Transport extends EnhancedEventEmitter
{
	/**
	 * @private
	 *
	 * @emits {transportLocalParameters: Object, callback: Function, errback: Function} connect
	 * @emits {producerLocalParameters: Object, callback: Function, errback: Function} send
	 * @emits {consumerLocalParameters: Object, callback: Function, errback: Function} receive
	 * @emits {connectionState: String} connectionstatechange
	 */
	constructor(
		{
			transportRemoteParameters,
			direction,
			iceServers,
			iceTransportPolicy,
			proprietaryConstraints,
			appData,
			Handler,
			extendedRtpCapabilities,
			recvRtpCapabilities,
			canSendByKind
		}
	)
	{
		super(logger);

		logger.debug(
			'constructor() [id:%s, direction:%s]',
			transportRemoteParameters.id, direction);

		// Id.
		// @type {String}
		this._id = transportRemoteParameters.id;

		// Closed flag.
		// @type {Boolean}
		this._closed = false;

		// Direction.
		// @type {String}
		this._direction = direction;

		// Extended RTP capabilities.
		// @type {Object}
		this._extendedRtpCapabilities = extendedRtpCapabilities;

		// Local RTP capabilities for receiving media.
		// @type {RTCRtpCapabilities}
		this._recvRtpCapabilities = recvRtpCapabilities;

		// Whether we can send audio/video based on computed extended RTP
		// capabilities.
		// @type {Object}
		this._canSendByKind = canSendByKind;

		// RTC handler instance.
		// @type {Handler}
		this._handler = new Handler(
			{
				transportRemoteParameters,
				direction,
				iceServers,
				iceTransportPolicy,
				proprietaryConstraints,
				extendedRtpCapabilities
			});

		// Transport connection state. Values can be:
		// 'new'/'connecting'/'connected'/'failed'/'disconnected'/'closed'
		// @type {String}
		this._connectionState = 'new';

		// App custom data.
		// @type {Any}
		this._appData = appData;

		// Map of producers indexed by id.
		// @type {map<String, Producer>}
		this._producers = new Map();

		// Map of consumers indexed by id.
		// @type {map<String, Consumer>}
		this._consumers = new Map();

		// Commands handler.
		// @type {CommandQueue}
		this._commandQueue = new CommandQueue();

		this._handleHandler();
	}

	/**
	 * Transport id.
	 *
	 * @return {String}
	 */
	get id()
	{
		return this._id;
	}

	/**
	 * Whether the Transport is closed.
	 *
	 * @return {Boolean}
	 */
	get closed()
	{
		return this._closed;
	}

	/**
	 * Transport direction.
	 *
	 * @return {String}
	 */
	get direction()
	{
		return this._direction;
	}

	/**
	 * RTC handler instance.
	 *
	 * @return {Handler}
	 */
	get handler()
	{
		return this._handler;
	}

	/**
	 * Connection state.
	 *
	 * @return {String}
	 */
	get connectionState()
	{
		return this._connectionState;
	}

	/**
	 * App custom data.
	 *
	 * @return {Any}
	 */
	get appData()
	{
		return this._appData;
	}

	/**
	 * App custom data.
	 *
	 * @type {Any}
	 */
	set appData(appData)
	{
		this._appData = appData;
	}

	/**
	 * Close the Transport.
	 */
	close()
	{
		logger.debug('close()');

		if (this._closed)
			return;

		this._closed = true;

		// Close the CommandQueue.
		this._commandQueue.close();

		// Close the handler.
		this._handler.close();

		// Close all the producers.
		for (const producer of this._producers.values())
		{
			producer.transportClosed();
		}
		this._producers.clear();

		// Close all the consumers.
		for (const consumer of this._consumers.values())
		{
			consumer.transportClosed();
		}
		this._consumers.clear();
	}

	/**
	 * Send a track.
	 *
	 * @param {MediaStreamTrack} track - Track to sent.
	 * @param {Object|Boolean} [simulcast] - Simulcast options.
	 * @param {Any} [appData] - Custom app data.
	 *
	 * @promise
	 * @fulfill {Producer}
	 * @reject {InvalidStateError} if transport closed or track ended.
	 * @reject {TypeError} if wrong arguments.
	 * @reject {UnsupportedError} if transport direction is incompatible or
	 *   cannot send the given media kind.
	 */
	send({ track, simulcast, appData } = {})
	{
		logger.debug('send() [track:%o]', track);

		if (!track)
			return Promise.reject(new TypeError('missing track'));
		else if (this._direction !== 'send')
			return Promise.reject(new UnsupportedError('not a sending transport'));
		else if (!this._canSendByKind[track.kind])
			return Promise.reject(new UnsupportedError(`cannot send ${track.kind}`));
		else if (track.readyState === 'ended')
			return Promise.reject(new InvalidStateError('track ended'));

		// Enqueue command.
		return this._commandQueue.push(
			() =>
			{
				let normalizedSimulcast;

				if (!simulcast || track.kind !== 'video')
				{
					normalizedSimulcast = false;
				}
				else if (simulcast === true)
				{
					normalizedSimulcast = utils.clone(SIMULCAST_DEFAULT);
				}
				else if (typeof simulcast === 'object')
				{
					const hasLow = typeof simulcast.low === 'number';
					const hasMedium = typeof simulcast.medium === 'number';
					const hasHigh = typeof simulcast.high === 'number';

					if (Number(hasLow) + Number(hasMedium) + Number(hasHigh) > 1)
					{
						normalizedSimulcast = {};

						if (hasLow)
							normalizedSimulcast.low = simulcast.low;
						if (hasMedium)
							normalizedSimulcast.medium = simulcast.medium;
						if (hasHigh)
							normalizedSimulcast.high = simulcast.high;
					}
					else
					{
						normalizedSimulcast = false;
					}
				}

				let trackHandled = false;
				let producerRtpParameters;

				return Promise.resolve()
					.then(() => this._handler.send({ track, simulcast: normalizedSimulcast }))
					.then((rtpParameters) =>
					{
						trackHandled = true;
						producerRtpParameters = rtpParameters;

						return this.safeEmitAsPromise(
							'send',
							// producerLocalParameters.
							{
								kind : track.kind,
								rtpParameters,
								appData
							});
					})
					.then((producerRemoteParameters) =>
					{
						const producer = new Producer(
							{
								id            : producerRemoteParameters.id,
								track,
								rtpParameters : producerRtpParameters,
								appData
							});

						this._producers.set(producer.id, producer);
						this._handleProducer(producer);

						return producer;
					})
					.catch((error) =>
					{
						if (trackHandled)
						{
							this._handler.stopSending({ track })
								.catch(() => {});
						}

						throw error;
					});
			})
			.catch((error) =>
			{
				try { track.stop(); }
				catch (error2) {}

				throw error;
			});
	}

	/**
	 * Receive a track.
	 *
	 * @param {String} producerId - Server-side producer id..
	 * @param {String} [preferredSpatialLayer] - Preferred spatial layer.
	 * @param {Any} [appData] - Custom app data.
	 *
	 * @promise
	 * @fulfill {Consumer}
	 * @reject {InvalidStateError} if transport closed.
	 * @reject {TypeError} if wrong arguments.
	 * @reject {UnsupportedError} if transport direction is incompatible.
	 */
	receive({ producerId, preferredSpatialLayer, appData } = {})
	{
		logger.debug('receive()');

		if (this._closed)
			return Promise.reject(new InvalidStateError('transport closed'));
		else if (!producerId)
			return Promise.reject(new TypeError('missing producerId'));
		else if (this._direction !== 'recv')
			return Promise.reject(new UnsupportedError('not a receiving transport'));

		// Enqueue command.
		return this._commandQueue.push(
			() =>
			{
				let consumerParameters;

				return Promise.resolve()
					.then(() =>
					{
						return this.safeEmitAsPromise(
							'receive',
							// consumerLocalParameters.
							{
								producerId,
								rtpCapabilities : this._recvRtpCapabilities,
								preferredSpatialLayer,
								appData
							});
					})
					.then((consumerRemoteParameters) =>
					{
						consumerParameters = consumerRemoteParameters;

						// Ensure the device can receive it.
						const canReceive = ortc.canReceive(
							consumerParameters.rtpParameters, this._extendedRtpCapabilities);

						if (!canReceive)
							throw new UnsupportedError('cannot receive this producer');

						return this._handler.receive(
							{
								id            : consumerParameters.id,
								kind          : consumerParameters.kind,
								rtpParameters : consumerParameters.rtpParameters
							});
					})
					.then((track) =>
					{
						if (track.kind !== 'video')
							preferredSpatialLayer = 'none';

						const consumer = new Consumer(
							{
								id            : consumerParameters.id,
								producerId,
								track,
								rtpParameters : consumerParameters.rtpParameters,
								preferredSpatialLayer,
								appData
							});

						this._consumers.set(consumer.id, consumer);
						this._handleConsumer(consumer);

						return consumer;
					});
			});
	}

	/**
	 * Get associated transport (RTCPeerConnection) stats.
	 *
	 * @promise
	 * @fulfill {RTCStatsReport}
	 * @reject {InvalidStateError} if transport closed.
	 */
	getStats()
	{
		if (this._closed)
			return Promise.reject(new InvalidStateError('transport closed'));

		try
		{
			return this._handler.getTransportStats();
		}
		catch (error)
		{
			return Promise.reject(error);
		}
	}

	/**
	 * Restart ICE connection.
	 *
	 * @param {RTCIceParameters} remoteIceParameters
	 *
	 * @promise
	 * @reject {InvalidStateError} if transport closed.
	 * @reject {TypeError} if wrong arguments.
	 */
	restartIce({ remoteIceParameters } = {})
	{
		logger.debug('restartIce()');

		if (this._closed)
			return Promise.reject(new InvalidStateError('transport closed'));
		else if (!remoteIceParameters)
			return Promise.reject(new TypeError('missing remoteIceParameters'));

		// Enqueue command.
		return this._commandQueue.push(
			() => this._handler.restartIce({ remoteIceParameters }));
	}

	/**
	 * Update ICE servers.
	 *
	 * @param {Array<RTCIceServer>} [iceServers] - Array of ICE servers.
	 *
	 * @promise
	 * @reject {InvalidStateError} if transport closed.
	 * @reject {TypeError} if wrong arguments.
	 */
	updateIceServers({ iceServers } = {})
	{
		logger.debug('updateIceServers()');

		if (this._closed)
			return Promise.reject(new InvalidStateError('transport closed'));
		else if (!Array.isArray(iceServers))
			return Promise.reject(new TypeError('missing iceServers'));

		// Enqueue command.
		return this._commandQueue.push(
			() => this._handler.updateIceServers({ iceServers }));
	}

	_handleHandler()
	{
		const handler = this._handler;

		handler.on('@connect', (transportLocalParameters, callback, errback) =>
		{
			if (this._closed)
			{
				errback(new InvalidStateError('transport closed'));

				return;
			}

			this.safeEmit('connect', transportLocalParameters, callback, errback);
		});

		handler.on('@connectionstatechange', (connectionState) =>
		{
			if (connectionState === this._connectionState)
				return;

			logger.debug('transport connection state changed to %s', connectionState);

			this._connectionState = connectionState;

			if (!this._closed)
				this.safeEmit('connectionstatechange', connectionState);
		});
	}

	_handleProducer(producer)
	{
		producer.on('@close', () =>
		{
			this._producers.delete(producer.id);

			if (this._closed)
				return;

			this._commandQueue.push(
				() => this._handler.stopSending({ track: producer.track }))
				.catch(() => {});
		});

		producer.on('@replacetrack', (newTrack, callback, errback) =>
		{
			this._commandQueue.push(
				() => this._handler.replaceTrack({ track: producer.track, newTrack }))
				.then(callback)
				.catch(errback);
		});

		producer.on('@getstats', (callback, errback) =>
		{
			if (this._closed)
				return errback(new InvalidStateError('transport closed'));

			try
			{
				return this._handler.getSenderStats({ track: producer.track })
					.then(callback)
					.catch(errback);
			}
			catch (error)
			{
				errback(error);
			}
		});
	}

	_handleConsumer(consumer)
	{
		consumer.on('@close', () =>
		{
			this._consumers.delete(consumer.id);

			if (this._closed)
				return;

			this._commandQueue.push(
				() => this._handler.stopReceiving({ id: consumer.id }))
				.catch(() => {});
		});

		consumer.on('@getstats', (callback, errback) =>
		{
			if (this._closed)
				return errback(new InvalidStateError('transport closed'));

			try
			{
				return this._handler.getReceiverStats({ id: consumer.id })
					.then(callback)
					.catch(errback);
			}
			catch (error)
			{
				errback(error);
			}
		});
	}
}

module.exports = Transport;
