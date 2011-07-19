var https = require('https');
var querystring = require('querystring');
var util = require('util');
var log = require('./util').log;
var fs = require('fs');
 
var mapping = {};
var options = {
	key: fs.readFileSync('server.key'),
	cert: fs.readFileSync('server.crt')
};

https.createServer(function (req, res) {
	switch(req.url) {
		case '/login':
			handlePOST(res, req, ['username', 'auth'], function(post) {			
					var gtalk = require('./gtalk')(post.username, post.auth);

					gtalk.on('auth_failure', function(details) {
						log.notice("[401] " + req.method + " to " + req.url);
						res.writeHead(401, "Authentication Required", {'Content-Type': 'text/plain'});
						res.end('401 - Authentication Required');
					}).on('message', log.debug).on('presence', log.debug);

					gtalk.login(function() {
						log.notice("[200] " + req.method + " to " + req.url);
						res.writeHead(200, "OK", {'Content-Type': 'text/plain'});

						var token = randomString(96);
						mapping[token] = gtalk;
						
						res.end(token);
					});
			});
			
			break;
		case '/message':
			handlePOST(res, req, ['token', 'to', 'body'], function(post) {
				log.notice("[200] " + req.method + " to " + req.url);
				res.writeHead(200, "OK", {'Content-Type': 'text/plain'});
				res.end();
				mapping[post.token].message(post.to, post.body);
			});
			
			break;
		case '/roster':
			handlePOST(res, req, ['token'], function(post) {
				log.notice("[200] " + req.method + " to " + req.url);
				res.writeHead(200, "OK", {'Content-Type': 'text/plain'});
				mapping[post.token].roster(function(ros) {
					if(ros == null) {
						res.end();
					} else {
						res.write(JSON.stringify(ros) + "\n");
					}
				});
			});
			
			break;
		case '/logout':
			handlePOST(res, req, ['token'], function(post) {
				log.notice("[200] " + req.method + " to " + req.url);
				res.writeHead(200, "OK", {'Content-Type': 'text/plain'});
				res.end();
				mapping[post.token].logout();
				mapping[post.token] = undefined;
			});
			
			break;
		case '/register':
			handlePOST(res, req, ['token', 'url'], function(post) {
				if(!post.url.match(/(https?):\/\/([a-z.-]+)(?::([0-9]+))?(\/.*)?$/)) {
					log.notice("[400] " + req.method + " to " + req.url);
					res.writeHead(400, "Bad Request", {'Content-Type': 'text/plain'});
					res.end('400 - Bad Request');
				} else {
					console.log("[200] " + req.method + " to " + req.url);
					res.writeHead(200, "OK", {'Content-Type': 'text/plain'});
					res.end();
					mapping[post.token].register(post.url);
				}
			});

		default:
			log.notice("[404] " + req.method + " to " + req.url);
			res.writeHead(404, "Not found", {'Content-Type': 'text/plain'});
			res.end('404 - Not found');
			break;
	}
}).listen(443);

function randomString(bits) {
	var rand, i;
	var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-/';
	var ret = '';
	
	// in v8, Math.random() yields 32 pseudo-random bits (in spidermonkey it gives 53)
	while(bits > 0) {
		rand = Math.floor(Math.random()*0x100000000); // 32-bit integer
		 
		// base 64 means 6 bits per character, so we use the top 30 bits from rand to give 30/6=5 characters.
		for(i = 26; i > 0 && bits > 0; i -= 6, bits -= 6) {
			ret += chars[0x3F & rand >>> i];
		}
	}
	
	return ret;
}

function handlePOST(res, req, params, cb) {
	if(req.method == 'POST') {
		var fullBody = '';

		req.on('data', function(chunk) {
			// append the current chunk of data to the fullBody variable
			fullBody += chunk.toString();
		}).on('end', function() {
			// parse the received body data
			var post = querystring.parse(fullBody);
			
			var valid = true;
			
			for(i = 0; i < params.length; i++) {
				if(!post[params[i]]) {
					valid = false;
					break;
				}
			}
		
			if(!valid) {
				log.notice("[400] " + req.method + " to " + req.url);
				res.writeHead(400, "Bad Request", {'Content-Type': 'text/plain'});
				res.end('400 - Bad Request');
			} else if(params.indexOf('token') != -1 && !mapping[post.token]) {
				log.notice("[404] " + req.method + " to " + req.url);
				res.writeHead(404, "Not found", {'Content-Type': 'text/plain'});
				res.end('404 - Not found');
			} else {
				cb(post);
			}
		});
	} else {
		log.notice("[405] " + req.method + " to " + req.url);
		res.writeHead(405, "Method not supported", {'Content-Type': 'text/plain'});
		res.end('405 - Method not supported');
	}
}

log.notice('Starting gtalkjsonproxy on port 433');
