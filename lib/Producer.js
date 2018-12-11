const Logger = require('./Logger');
const EnhancedEventEmitter = require('./EnhancedEventEmitter');
const { InvalidStateError, DuplicatedError } = require('./errors');

const logger = new Logger('Producer');

class Producer extends EnhancedEventEmitter
{
	/**
	 * @private
	 *
	 * @emits transportclose
	 * @emits trackended
	 * @emits {track: MediaStreamTrack} @replacetrack
	 * @emits @getstats
	 * @emits @close
	 */
	constructor({ id, track, rtpParameters, appData })
	{
		super(logger);

		// Id.
		// @type {String}
		this._id = id;

		// Closed flag.
		// @type {Boolean}
		this._closed = false;

		// Local track.
		// @type {MediaStreamTrack}
		this._track = track;

		// RTP parameters.
		// @type {RTCRtpParameters}
		this._rtpParameters = rtpParameters;

		// Paused flag.
		// @type {Boolean}
		this._paused = !track.enabled;

		// App custom data.
		// @type {Any}
		this._appData = appData;

		this._onTrackEnded = this._onTrackEnded.bind(this);

		this._handleTrack();
	}

	/**
	 * Producer id.
	 *
	 * @return {String}
	 */
	get id()
	{
		return this._id;
	}

	/**
	 * Whether the producer is closed.
	 *
	 * @return {Boolean}
	 */
	get closed()
	{
		return this._closed;
	}

	/**
	 * Media kind.
	 *
	 * @return {String}
	 */
	get kind()
	{
		return this._track.kind;
	}

	/**
	 * The associated track.
	 *
	 * @return {MediaStreamTrack}
	 */
	get track()
	{
		return this._track;
	}

	/**
	 * RTP parameters.
	 *
	 * @return {RTCRtpParameters}
	 */
	get rtpParameters()
	{
		return this._rtpParameters;
	}

	/**
	 * Whether the producer is paused.
	 *
	 * @return {Boolean}
	 */
	get paused()
	{
		return this._paused;
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
	 * Closes the producer.
	 */
	close()
	{
		logger.debug('close()');

		if (this._closed)
			return;

		this._closed = true;

		this._destroyTrack();

		this.emit('@close');
	}

	/**
	 * Transport was closed.
	 *
	 * @private
	 */
	transportClosed()
	{
		if (this._closed)
			return;

		this._closed = true;

		this._destroyTrack();

		this.safeEmit('transportclose');
	}

	/**
	 * Pauses sending media.
	 */
	pause()
	{
		logger.debug('pause()');

		if (this._closed)
		{
			logger.error('pause() | producer closed');

			return;
		}

		this._paused = true;
		this._track.enabled = false;
	}

	/**
	 * Resumes sending media.
	 */
	resume()
	{
		logger.debug('resume()');

		if (this._closed)
		{
			logger.error('resume() | producer closed');

			return;
		}

		this._paused = false;
		this._track.enabled = true;
	}

	/**
	 * Replaces the current track with a new one.
	 *
	 * @param {MediaStreamTrack} track - New track.
	 *
	 * @promise
	 * @reject {InvalidStateError} if producer closed or track ended.
	 * @reject {TypeError} if wrong arguments.
	 */
	replaceTrack({ track } = {})
	{
		logger.debug('replaceTrack() [track:%o]', track);

		if (this._closed)
		{
			// This must be done here. Otherwise there is no chance to stop the given
			// track.
			try { track.stop(); }
			catch (error) {}

			return Promise.reject(new InvalidStateError('producer closed'));
		}
		else if (!track)
		{
			return Promise.reject(new TypeError('missing track'));
		}
		else if (track.readyState === 'ended')
		{
			return Promise.reject(new InvalidStateError('track ended'));
		}

		return Promise.resolve()
			.then(() =>
			{
				return this.safeEmitAsPromise('@replacetrack', track);
			})
			.then(() =>
			{
				// Destroy the previous track.
				this._destroyTrack();

				// Set the new track.
				this._track = track;

				// If this producer was paused/resumed and the state of the new
				// track does not match, fix it.
				if (!this._paused)
					this._track.enabled = true;
				else
					this._track.enabled = false;

				// Handle the effective track.
				this._handleTrack();
			})
			.catch((error) =>
			{
				// NOTE: Don't stop the given track if it was rejected because the
				// track was already handled.
				if (error.name !== DuplicatedError.name)
				{
					try { track.stop(); }
					catch (error2) {}
				}

				throw error;
			});
	}

	/**
	 * Get associated RTCRtpSender stats.
	 *
	 * @promise
	 * @fulfill {RTCStatsReport}
	 * @reject {InvalidStateError} if producer closed.
	 */
	getStats()
	{
		if (this._closed)
			return Promise.reject(new InvalidStateError('producer closed'));

		return this.safeEmitAsPromise('@getstats');
	}

	/**
	 * @private
	 */
	_onTrackEnded()
	{
		logger.debug('track "ended" event');

		this.safeEmit('trackended');
	}

	/**
	 * @private
	 */
	_handleTrack()
	{
		this._track.addEventListener('ended', this._onTrackEnded);
	}

	/**
	 * @private
	 */
	_destroyTrack()
	{
		try
		{
			this._track.removeEventListener('ended', this._onTrackEnded);
			this._track.stop();
		}
		catch (error)
		{}
	}
}

module.exports = Producer;
