var https = require('https'),
    querystring = require('querystring'),
    util = require('./util'),
    logging = require('./log'),
    fs = require('fs'),
    redis = require("redis"),
    client = redis.createClient();

logging.rootLogger.level = logging.DEBUG;

var logger = logging.log('service');
 
var pushMapping = {};
var mapping = {};
var tokens = {};
var options = {
	key: fs.readFileSync('server.key'),
	cert: fs.readFileSync('server.crt')
};

require('./gtalk').initClientCert(
	fs.readFileSync('client.key'),
	fs.readFileSync('client.crt')
);

util.crypto.init(fs.readFileSync('crypt.key'));

https.createServer(options, function (req, res) {
	switch(req.url) {
		case '/login':
			handlePOST(res, req, ['username', 'auth'], function(post) {
				if(tokens[post.username + ":" + post.auth]) {
					var token = tokens[post.username + ":" + post.auth];
					
					if(mapping[token]) {
						logger.notice("[200] " + req.method + " to " + req.url);
						res.writeHead(200, "OK", {'Content-Type': 'text/plain'});

						res.end(token + "\nhttps://gtalkjsonproxy.lhchavez.com");
						logger.trace('recycled the token %s', token);
						return;
					} else {
						// why is there a token, but not a mapping?
						
						delete tokens[post.username + ":" + post.auth];
					}
				}

				var gtalk = require('./gtalk').gtalk(util.randomString(96), post.username, post.auth);

				gtalk.on('auth_failure', function(details) {
					logger.notice("[401] " + req.method + " to " + req.url);
					res.writeHead(401, "Authentication Required", {'Content-Type': 'text/plain'});
					res.end('401 - Authentication Required');
				}).on('disconnect', function() {
					if (!mapping[gtalk.token]) {
						logger.error('There was a race condition ending the session for %s', gtalk.username);
					} else {
						logger.notice('session ended for %s', gtalk.username);
					}
					
					delete tokens[gtalk.username + ':' + gtalk.auth];
					delete mapping[gtalk.token];
				});
				
				/*
				gtalk.on('message', function(data) {
					logger.trace("message: %s", data);
				});
				gtalk.on('presence', function(data) {
					logger.trace("message: %s", data);
				});
				*/

				gtalk.login(function() {
					logger.notice("[200] " + req.method + " to " + req.url);
					res.writeHead(200, "OK", {'Content-Type': 'text/plain'});
					
					logger.notice('session started ' + gtalk.username);

					mapping[gtalk.token] = gtalk;
					tokens[post.username + ":" + post.auth] = gtalk.token;
					
					res.end(gtalk.token + "\nhttps://gtalkjsonproxy.lhchavez.com");
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
					if(type == 'error') {
						logger.notice("[404] " + req.method + " to " + req.url);
						res.writeHead(404, "Not Found", {'Content-Type': 'text/plain'});
						res.end();
					} else {
						logger.notice("[200] " + req.method + " to " + req.url);
						res.writeHead(200, "OK", {'Content-Type': type, 'Content-Length': photo.length});
						res.end(photo, 'binary');
					}
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
				
				delete tokens[mapping[post.token].username + ':' + mapping[post.token].auth];
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
					res.end(mapping[post.token].jid);
					mapping[post.token].register(post.url, post.tiles);
					
					if(mapping[pushMapping[post.url]] && pushMapping[post.url] != post.token) {
						mapping[pushMapping[post.url]].logout(true);
					}
					pushMapping[post.url] = post.token;
				}
			});

			break;
		case '/otr':
			handlePOST(res, req, ['token', 'jid'], function(post) {
				logger.notice("[200] " + req.method + " to " + req.url);
				res.writeHead(200, "OK", {'Content-Type': 'text/plain'});
				res.end();
				mapping[post.token].otr(post.jid, post.enabled == 'True');
			});

			break;
		case '/notifications':
			handlePOST(res, req, ['token'], function(post) {
				logger.notice("[200] " + req.method + " to " + req.url);
				res.writeHead(200, "OK", {'Content-Type': 'text/plain'});
				res.end();
				
				mapping[post.token].notifications(post.jid, post.toast == 'True', post.tile == 'True', post.secondarytile == 'True');
			});

			break;
		case '/rawiq':
			handlePOST(res, req, ['token', 'body'], function(post) {
				mapping[post.token].rawiq(post.id, post.body, function(iq) {				
					logger.notice("[200] " + req.method + " to " + req.url);
					res.writeHead(200, "OK", {'Content-Type': 'text/xml'});
					
					if(iq) {
						res.end(util.xmlify('iq', iq));
					} else {
						res.end();
					}
				});
			});

			break;
		case '/jingle':
			handlePOST(res, req, ['token'], function(post) {				
				logger.notice("[200] " + req.method + " to " + req.url);
				res.writeHead(200, "OK", {'Content-Type': 'text/xml'});
				
				res.end('<servers>' + util.xmlify('stun', mapping[post.token].jingle) + '</servers>');
			});

			break;
		case '/crashreport':
			handlePOST(res, req, ['exception'], function(post) {				
				logger.notice("[200] " + req.method + " to " + req.url);
				res.writeHead(200, "OK", {'Content-Type': 'text/xml'});
				res.end();
				
				client.rpush('crashreports', post.exception);
			});

			break;
		default:
			if(/\/images\/[a-f0-9]{32}/.test(req.url)) {
				logger.notice("[200] " + req.method + " to " + req.url);
				fs.readFile(req.url.substring(1), function(err, data) {
					if(err) {
						fs.readFile('pixel.png', function(err, data) {
							res.writeHead(200, "OK", {'Content-Type': 'image/png', 'Content-Length': '103'});
							res.end(data);
						});
					} else {
						res.writeHead(200, "OK", {'Content-Type': 'image/jpg', 'Content-Length': data.length});
						res.end(data);
					}
				});
			} else {
				logger.notice("[404] " + req.method + " to " + req.url);
				res.writeHead(404, "Not found", {'Content-Type': 'text/plain'});
				res.end('404 - Not found');
			}
			
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
				logger.notice("[403] " + req.method + " to " + req.url);
				res.writeHead(403, "Forbidden", {'Content-Type': 'text/plain'});
				res.end('403 - Forbidden');
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
				
				var gtalk = require('./gtalk').gtalk(JSON.parse(deciphered));

				gtalk.on('auth_failure', function(details) {
					logger.notice('unable to restore session for ' + gtalk.username);
					client.srem('clients', c);
					client.del(c);
				}).on('disconnect', function() {
					logger.notice('session ended ' + mapping[gtalk.token].username);
					
					delete tokens[gtalk.username + ':' + gtalk.auth];
					delete mapping[gtalk.token];
				}).on('message', function(data) { logger.trace("message: %s", data); });

				gtalk.login(function() {
					logger.notice('session started ' + gtalk.username);

					mapping[gtalk.token] = gtalk;
					tokens[gtalk.username + ":" + gtalk.auth] = gtalk.token;
					
					if(gtalk.callback) {
						if(mapping[pushMapping[gtalk.callback]]) {
							mapping[pushMapping[gtalk.callback]].logout(true);
						}
						pushMapping[gtalk.callback] = gtalk.token;
					}
				});
			} else {
				client.srem('clients', c);
				client.del(c);
			}
		});
	});
});