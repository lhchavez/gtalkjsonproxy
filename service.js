var http = require('http');
var querystring = require('querystring');
var util = require('util');

var mapping = {};

http.createServer(function (req, res) {
	switch(req.url) {
		case '/login':
			if(req.method == 'POST') {
				var fullBody = '';

				req.on('data', function(chunk) {
					// append the current chunk of data to the fullBody variable
					fullBody += chunk.toString();
				}).on('end', function() {
					// parse the received body data
					var post = querystring.parse(fullBody);
					
					if(!post.username || !post.auth) {
						console.log("[400] " + req.method + " to " + req.url);
						res.writeHead(400, "Bad Request", {'Content-Type': 'text/plain'});
						res.end('400 - Bad Request');
					} else {
						var gtalk = require('./gtalk')(post.username, post.auth);

						gtalk.on('auth_failure', function(details) {
							console.log("[401] " + req.method + " to " + req.url);
							res.writeHead(401, "Authentication Required", {'Content-Type': 'text/plain'});
							res.end('401 - Authentication Required');
						}).on('message', function(data) {
							console.log('message');
							console.log(JSON.stringify(data));
							console.log("\n");
						}).on('presence', function(data) {
							//console.log('presence');
							//console.log(JSON.stringify(data));
							//console.log("\n");
						});

						gtalk.login(function() {
							console.log("[200] " + req.method + " to " + req.url);
							res.writeHead(200, "OK", {'Content-Type': 'text/plain'});

							var token = randomString(96);
							mapping[token] = gtalk;
							res.end(token);
						});
					}
				});
			} else {
				console.log("[405] " + req.method + " to " + req.url);
				res.writeHead(405, "Method not supported", {'Content-Type': 'text/plain'});
				res.end('405 - Method not supported');
			}
			break;
		case '/message':
			if(req.method == 'POST') {
				var fullBody = '';

				req.on('data', function(chunk) {
					// append the current chunk of data to the fullBody variable
					fullBody += chunk.toString();
				}).on('end', function() {
					// parse the received body data
					var post = querystring.parse(fullBody);
					
					if(!post.token || !post.to || !post.body) {
						console.log("[400] " + req.method + " to " + req.url);
						res.writeHead(400, "Bad Request", {'Content-Type': 'text/plain'});
						res.end('400 - Bad Request');
					} else if(!mapping[post.token]) {
						console.log("[404] " + req.method + " to " + req.url);
						res.writeHead(404, "Not found", {'Content-Type': 'text/plain'});
						res.end('404 - Not found');
					} else {
						console.log("[200] " + req.method + " to " + req.url);
						res.writeHead(200, "OK", {'Content-Type': 'text/plain'});
						res.end();
						mapping[post.token].message(post.to, post.body);
					}
				});
			} else {
				console.log("[405] " + req.method + " to " + req.url);
				res.writeHead(405, "Method not supported", {'Content-Type': 'text/plain'});
				res.end('405 - Method not supported');
			}
			break;
		case '/roster':
			if(req.method == 'POST') {
				var fullBody = '';

				req.on('data', function(chunk) {
					// append the current chunk of data to the fullBody variable
					fullBody += chunk.toString();
				}).on('end', function() {
					// parse the received body data
					var post = querystring.parse(fullBody);
					
					if(!post.token) {
						console.log("[400] " + req.method + " to " + req.url);
						res.writeHead(400, "Bad Request", {'Content-Type': 'text/plain'});
						res.end('400 - Bad Request');
					} else if(!mapping[post.token]) {
						console.log("[404] " + req.method + " to " + req.url);
						res.writeHead(404, "Not found", {'Content-Type': 'text/plain'});
						res.end('404 - Not found');
					} else {
						console.log("[200] " + req.method + " to " + req.url);
						res.writeHead(200, "OK", {'Content-Type': 'text/plain'});
						mapping[post.token].roster(function(ros) {
							if(ros == null) {
								res.end();
							} else {
								res.write(JSON.stringify(ros) + "\n");
							}
						});
					}
				});
			} else {
				console.log("[405] " + req.method + " to " + req.url);
				res.writeHead(405, "Method not supported", {'Content-Type': 'text/plain'});
				res.end('405 - Method not supported');
			}
			break;
		case '/logout':
			if(req.method == 'POST') {
				var fullBody = '';

				req.on('data', function(chunk) {
					// append the current chunk of data to the fullBody variable
					fullBody += chunk.toString();
				}).on('end', function() {
					// parse the received body data
					var post = querystring.parse(fullBody);
					
					if(!post.token) {
						console.log("[400] " + req.method + " to " + req.url);
						res.writeHead(400, "Bad Request", {'Content-Type': 'text/plain'});
						res.end('400 - Bad Request');
					} else if(!mapping[post.token]) {
						console.log("[404] " + req.method + " to " + req.url);
						res.writeHead(404, "Not found", {'Content-Type': 'text/plain'});
						res.end('404 - Not found');
					} else {
						console.log("[200] " + req.method + " to " + req.url);
						res.writeHead(200, "OK", {'Content-Type': 'text/plain'});
						res.end();
						mapping[post.token].logout();
						mapping[post.token] = undefined;
					}
				});
			} else {
				console.log("[405] " + req.method + " to " + req.url);
				res.writeHead(405, "Method not supported", {'Content-Type': 'text/plain'});
				res.end('405 - Method not supported');
			}
			break;
		default:
			console.log("[404] " + req.method + " to " + req.url);
			res.writeHead(404, "Not found", {'Content-Type': 'text/plain'});
			res.end('404 - Not found');
			break;
	}
}).listen(8080, '0.0.0.0');

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
