/**
 * System is unusable.
 * 
 * @type Number
 */

exports.EMERGENCY = 0;

/**
 * Action must be taken immediately.
 * 
 * @type Number 
 */

exports.ALERT = 1;

/**
 * Critical condition.
 *
 * @type Number
 */

exports.CRITICAL = 2;

/**
 * Error condition.
 * 
 * @type Number
 */

exports.ERROR = 3;

/**
 * Warning condition.
 * 
 * @type Number
 */

exports.WARNING = 4;

/**
 * Normal but significant condition.
 * 
 * @type Number
 */

exports.NOTICE = 5;

/**
 * Purely informational message.
 * 
 * @type Number
 */

exports.INFO = 6;

/**
 * Application debug messages.
 * 
 * @type Number
 */

exports.DEBUG = 7;

/**
 * Protocol tracing messages.
 * 
 * @type Number
 */

exports.TRACE = 8;

var levelStr = ["EMERGENCY", "ALERT", "CRITICAL", "ERROR", "WARNING", "NOTICE", "INFO", "DEBUG", "TRACE"];

var Log = function(level, module, stream) {
	this.level = level;
	this.stream = stream || process.stdout;
	this.module = module;
};

Log.prototype.log = function(level, args) {
	if (level <= this.level) {
		var i = 1;
		var msg = "";
		
		if(args[0]) {
			var fmt = args[0];
			
			if(typeof(fmt) == 'function') {
				fmt = fmt();
			}

			if(typeof(fmt) == 'string') {
				msg = fmt.replace(/%s/g, function(){
					if(args[i]) {
						if(typeof(args[i]) == 'function') {
							return args[i++]();
						} else if(typeof(args[i]) == 'string') {
							return args[i++];
						} else {
							return JSON.stringify(args[i++]);
						}
					} else {
						return "";
					}
				});
			} else {
				msg = JSON.stringify(fmt);
			}
				
			for(; i < args.length; i++) {
				msg += ", ";
				
				if(typeof(args[i]) == 'function') {
					msg += args[i]();
				} else if(typeof(args[i]) == 'string') {
					msg += args[i];
				} else {
					msg += JSON.stringify(args[i]);
				}
			}
		}
		
		this.stream.write(
			'[' + new Date().toUTCString() + ']'
			+ ' [' + this.module + ']'
			+ ' ' + levelStr[level]
			+ ' ' + msg
			+ '\n'
		);
	}
};


/**
* Log emergency `msg`.
*
* @param  {String} msg
* @api public
*/

Log.prototype.emergency = function(msg){
	this.log(exports.EMERGENCY, arguments);
},

/**
* Log alert `msg`.
*
* @param  {String} msg
* @api public
*/

Log.prototype.alert = function(msg){
	this.log(exports.ALERT, arguments);
},

/**
* Log critical `msg`.
*
* @param  {String} msg
* @api public
*/

Log.prototype.critical = function(msg){
	this.log(exports.CRITICAL, arguments);
};

/**
* Log error `msg`.
*
* @param  {String} msg
* @api public
*/

Log.prototype.error = function(msg){
	this.log(exports.ERROR, arguments);
};

/**
* Log warning `msg`.
*
* @param  {String} msg
* @api public
*/

Log.prototype.warning = function(msg){
	this.log(exports.WARNING, arguments);
};

/**
* Log notice `msg`.
*
* @param  {String} msg
* @api public
*/

Log.prototype.notice = function(msg){
	this.log(exports.NOTICE, arguments);
};

/**
* Log info `msg`.
*
* @param  {String} msg
* @api public
*/ 

Log.prototype.info = function(msg){
	this.log(exports.INFO, arguments);
};

/**
* Log debug `msg`.
*
* @param  {String} msg
* @api public
*/

Log.prototype.debug = function(msg){
	this.log(exports.DEBUG, arguments);
};

/**
* Log trace `msg`.
*
* @param  {String} msg
* @api public
*/

Log.prototype.trace = function(msg){
	this.log(exports.TRACE, arguments);
};

exports.rootLogger = new Log(exports.ERROR, 'root');
exports.log = function(module) {
	return new Log(exports.rootLogger.level, module, exports.rootLogger.stream);
};
