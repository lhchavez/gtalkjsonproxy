var https = require('https');
var querystring = require('querystring');
var util = require('./util');
var logging = require('./log');
var fs = require('fs');
var redis = require("redis"),
    client = redis.createClient();

logging.rootLogger.level = logging.DEBUG;

var logger = logging.log('service');
 
var mapping = {};
var tokens = {};
var options = {
	key: fs.readFileSync('server.key'),
	cert: fs.readFileSync('server.crt')
};

util.crypto.init(fs.readFileSync('crypt.key'));

https.createServer(options, function (req, res) {
	switch(req.url) {
		case '/login':
			handlePOST(res, req, ['username', 'auth'], function(post) {
					if(tokens[post.username + ":" + post.auth]) {
						logger.notice("[200] " + req.method + " to " + req.url);
						res.writeHead(200, "OK", {'Content-Type': 'text/plain'});

						var token = tokens[post.username + ":" + post.auth];
						res.end(token);
						logger.debug('recycled the token %s', token);
						return;
					}

					var gtalk = require('./gtalk')(util.randomString(96), post.username, post.auth);

					gtalk.on('auth_failure', function(details) {
						logger.notice("[401] " + req.method + " to " + req.url);
						res.writeHead(401, "Authentication Required", {'Content-Type': 'text/plain'});
						res.end('401 - Authentication Required');
					}).on('disconnect', function() {						
						logger.notice('session ended ' + mapping[gtalk.token].username);
						delete mapping[gtalk.token];
					}).on('message', function(data) {
						logger.trace("message: %s", data);
					});
					//.on('presence', function(data) { logger.debug("message: %s", data); });

					gtalk.login(function() {
						logger.notice("[200] " + req.method + " to " + req.url);
						res.writeHead(200, "OK", {'Content-Type': 'text/plain'});
						
						logger.notice('session started ' + gtalk.username);

						mapping[gtalk.token] = gtalk;
						tokens[post.username + ":" + post.auth] = gtalk.token;
						
						res.end(gtalk.token);
					});
			});
			
			break;
		case '/message':
			handlePOST(res, req, ['token', 'to', 'body'], function(post) {
				logger.notice("[200] " + req.method + " to " + req.url);
				res.writeHead(200, "OK", {'Content-Type': 'text/plain'});
				res.end();
				mapping[post.token].message(post.to, post.body);
			});
			
			break;
		case '/presence':
			handlePOST(res, req, ['token', 'show'], function(post) {
				logger.notice("[200] " + req.method + " to " + req.url);
				res.writeHead(200, "OK", {'Content-Type': 'text/plain'});
				res.end();
				mapping[post.token].presence(post.show, post.status);
			});
			
			break;
		case '/key':
			handlePOST(res, req, ['token'], function(post) {
				logger.notice("[200] " + req.method + " to " + req.url);
				res.writeHead(200, "OK", {'Content-Type': 'text/plain'});
				res.end(mapping[post.token].userKey);
			});
			
			break;
		case '/photo':
			handlePOST(res, req, ['token', 'jid'], function(post) {
				mapping[post.token].photo(post.jid, function(type, photo) {
					logger.notice("[200] " + req.method + " to " + req.url);
					res.writeHead(200, "OK", {'Content-Type': type, 'Content-Length': photo.length});
					res.end(photo, 'binary');
				});
			});
			
			break;
		case '/roster':
			handlePOST(res, req, ['token'], function(post) {
				logger.notice("[200] " + req.method + " to " + req.url);
				res.writeHead(200, "OK", {'Content-Type': 'text/json'});
				mapping[post.token].roster(function(ros) {
					if(ros == null) {
						res.end();
					} else {
						res.write(JSON.stringify(ros) + "\n");
					}
				});
			});
			
			break;
		case '/messagequeue':
			handlePOST(res, req, ['token'], function(post) {
				logger.notice("[200] " + req.method + " to " + req.url);
				res.writeHead(200, "OK", {'Content-Type': 'text/json'});
				mapping[post.token].messageQueue(function(msg) {
					if(msg === null) {
						res.end();
					} else {
						res.write(msg + "\n");
					}
				});
			});
			
			break;
		case '/logout':
			handlePOST(res, req, ['token'], function(post) {
				logger.notice("[200] " + req.method + " to " + req.url);
				res.writeHead(200, "OK", {'Content-Type': 'text/plain'});
				res.end();
				
				logger.notice('session ended ' + mapping[post.token].username);
				mapping[post.token].logout();
				delete mapping[post.token];
			});
			
			break;
		case '/register':
			handlePOST(res, req, ['token', 'url'], function(post) {
				if(!post.url.match(/(https?):\/\/([a-z0-9.-]+)(?::([0-9]+))?(\/.*)?$/)) {
					logger.notice("[400] " + req.method + " to " + req.url);
					logger.debug('what the url? %s', post.url);
					res.writeHead(400, "Bad Request", {'Content-Type': 'text/plain'});
					res.end('400 - Bad Request');
				} else {
					logger.notice("[200] " + req.method + " to " + req.url);
					res.writeHead(200, "OK", {'Content-Type': 'text/plain'});
					res.end();
					mapping[post.token].register(post.url);
				}
			});

			break;
		default:
			logger.notice("[404] " + req.method + " to " + req.url);
			res.writeHead(404, "Not found", {'Content-Type': 'text/plain'});
			res.end('404 - Not found');
			break;
	}
}).listen(443);

function handlePOST(res, req, params, cb) {
	if(req.method == 'POST') {
		var fullBody = '';

		req.on('data', function(chunk) {
			// append the current chunk of data to the fullBody variable
			fullBody += chunk.toString();
		}).on('end', function() {
			// parse the received body data
			var post = querystring.parse(fullBody);

			logger.trace('\tRequest %s ', post);

			var tokens = [];
			for(var tokn in mapping) {
				tokens.push(tokn);
			}

			logger.trace('\tTokens %s ', tokens);
			
			var valid = true;
			
			for(i = 0; i < params.length; i++) {
				if(!post[params[i]]) {
					valid = false;
					break;
				}
			}
		
			if(!valid) {
				logger.notice("[400] " + req.method + " to " + req.url);
				logger.debug("something was missing.");
				logger.trace("expecting %s, got %s", params, post);
				res.writeHead(400, "Bad Request", {'Content-Type': 'text/plain'});
				res.end('400 - Bad Request');
			} else if(params.indexOf('token') != -1 && !mapping[post.token]) {
				logger.notice("[404] " + req.method + " to " + req.url);
				res.writeHead(404, "Not found", {'Content-Type': 'text/plain'});
				res.end('404 - Not found');
			} else {
				cb(post);
			}
		});
	} else {
		logger.notice("[405] " + req.method + " to " + req.url);
		res.writeHead(405, "Method not supported", {'Content-Type': 'text/plain'});
		res.end('405 - Method not supported');
	}
}

process.setuid('gtalk');
logger.notice('Starting gtalkjsonproxy on port 433');

client.smembers('clients', function(err, clients) {
	if(clients == null) return;
	
	clients.forEach(function (c) {
		client.get(c, function (err, data) {
			if(data) {
				var deciphered = util.crypto.decipher(data);
				
				logger.trace("unserialized data: %s", deciphered);
				
				var gtalk = require('./gtalk')(JSON.parse(deciphered));

				gtalk.on('auth_failure', function(details) {
					logger.notice('unable to restore session for ' + gtalk.username);
					client.srem('clients', c);
				}).on('disconnect', function() {						
					logger.notice('session ended ' + mapping[gtalk.token].username);
					delete mapping[gtalk.token];
				}).on('message', function(data) { logger.trace("message: %s", data); });

				gtalk.login(function() {
					logger.notice('session started ' + gtalk.username);

					mapping[gtalk.token] = gtalk;
					tokens[gtalk.username + ":" + gtalk.auth] = gtalk.token;
				});
			} else {
				client.srem('clients', c);
			}
		});
	});
});
