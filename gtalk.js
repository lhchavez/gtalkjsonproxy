var logger = require('./log').log('gtalk'),
    fs = require('fs'),
    util = require('./util'),
    timers = require('timers'),
    redis = require("redis"),
    client = redis.createClient();

var awayTimeout = 15 * 60 * 1000; // 15 min
var xaTimeout = 15 * 60 * 1000; // 30 min
var disconnectTimeout = 90 * 60 * 1000; // 2h

var clientCert = undefined;
var clientKey = undefined;

function gtalk(token, username, auth) {
	
	logger.trace('instantiating with %s, %s %s', token, username, auth);
	
	if(typeof(token) == 'object') {
		this.clientId = token.clientId;
		this.token = token.token;
		this.username = token.username;
		this.auth = token.auth;
		this.callback = token.callback;
		this.status = token.status;
		this.unreadFor = token.unreadFor || {};
		this.key = token.key;
		this.sendToasts = token.sendToasts;
		this.sendTiles = token.sendTiles;
	} else {
		var address = username.toLowerCase().split('@'),
			user = address[0],
			domain = address[1] || 'gmail.com';
		
		if(domain == 'gmail.com') user = user.replace(/\./g, '');
		
		this.key = user + '@' + domain;
		this.username = username;
		if(this.username.indexOf('@') == -1) this.username += '@gmail.com';
		this.clientId = 'client:' + util.randomString(128);
		this.token = token;
		this.auth = auth;
		this.callback = undefined;
		this.status = {};
		this.unreadFor = {};
		this.sendToasts = true;
		this.sendTiles = true;
	}
	
	this.server = this.username.split('@')[1];
	this.logged_in = false;
	this.jid = undefined;
	this.sock = undefined;
	this.rosterList = {};
	this.sendRaw = true;
	this.timer = undefined;
	this.disconnected = false;
	this.iqCallbacks = {};
	this.iqCounter = 1;
	this.unreadCount = 0;
	this.lastId = '';
	
	var self = this;
	
	client.get('key:' + this.key, function(err, data) {
		if(data) {
			self.userKey = util.crypto.decipher(data);
		} else {
			self.userKey = util.randomString(66);
			
			client.set('key:' + self.key, util.crypto.cipher(self.userKey));
		}
	});
	
	client.llen('messages:' + this.key, function(err, data) {
		self.unreadCount += data;
	});
	
	logger.trace("gtalk instance created: %s", this);
};

gtalk.prototype = new process.EventEmitter();

gtalk.prototype.login = function(cb) {
	var base64_encode = require("base64").encode;
	var Buffer = require('buffer').Buffer;
	var xml2js = require('xml2js');

	var s = require("net").createConnection(5222, 'talk.google.com');
	var self = this;
	
	s.on('connect', function() {
		s.write("<?xml version='1.0'?>\n<stream:stream to='" + self.server + "' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>");
	}).on('data', function(data) {
		var str = data.toString('utf8');

		logger.trace(str);
	
		if(str.indexOf('stream:features') != -1) {
			s.write("<starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls' />");
		} else if(str.indexOf('proceed') != -1) {
			s.removeAllListeners('data');
		
			require('./starttls')(s, {}, function(ss) {
				if(!ss.authorized) {
					self.emit('auth_failure', ss.authorizationError);
					ss.destroy();
					return;
				}
			
				ss.write("<stream:stream to='" + self.server + "' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>");
				self.sock = ss;
				
				var expecting_roster = false;
				var roster_text = "";
			
				ss.on('data', function(data) {
					var str = data.toString('utf8');

					logger.trace("raw, unbuffered data: %s", str);
				
					if(str.indexOf('stream:features') != -1) {
						if(self.logged_in) {
							ss.write("<iq type='set' id='bind_resource'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><resource>wpmango</resource></bind></iq>");
						} else {
							var token = base64_encode(new Buffer('\u0000' + self.username + '\u0000' + self.auth));
					
							ss.write("<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='X-GOOGLE-TOKEN'>" + token + "</auth>");
						}
					} else if(str.indexOf('success') != -1) {
						self.logged_in = true;
						
						ss.write("<stream:stream to='" + self.server + "' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>");
						
						client.sadd('clients', self.clientId);
						self.persist();
					} else if(str.indexOf('failure') != -1) {
						self.emit('auth_failure', str);
						logger.debug('auth_failure: %s', str);
						self.logout();
					} else if(str.indexOf('iq') != -1) {
						if(str.indexOf('bind_resource') != -1) {
							self.jid = str.match(/<jid>([^>]*)<\/jid>/)[1];
							
							ss.write("<iq to='" + self.server + "' type='set' id='session'><session xmlns='urn:ietf:params:xml:ns:xmpp-session'/></iq>");
						} else if(str.indexOf('session') != -1) {
							ss.write("<iq from='" + self.jid + "' type='get' id='roster'><query xmlns='jabber:iq:roster'/></iq>");
							expecting_roster = true;
						} else if(expecting_roster) {
							roster_text += str;
							
							if(str.indexOf('</iq>') == -1) {
								return;
							}
							
							var roster_parser = new xml2js.Parser();
							
							roster_parser.addListener('end', function(result) {
								if(result.query.item.length) {
									for(i = 0; i < result.query.item.length; i++) {
										var ros = self.stripRoster(result.query.item[i]);
										self.rosterList[ros.jid] = ros;
									}
								} else {
									var ros = self.stripRoster(result.query.item);
									self.rosterList[ros.jid] = ros;
								}
							
								if(cb) cb();
							});
							
							roster_parser.parseString(roster_text);
							
							var xmlStream = new util.XmlStream();
							xmlStream.on('data', function(d) {
								var parser = new xml2js.Parser();
								
								logger.trace("complete XML object: %s", d);
							
								parser.addListener('end', function(result) {
									if(result.presence) {
										if(result.presence.length) {
											for(i = 0; i < result.presence.length; i++) {
												self.emit('presence', self.stripPresence(result.presence[i]));
											}
										} else {
											self.emit('presence', self.stripPresence(result.presence));
										}
									} else if(result.message) {
										if(result.message.length) {
											for(i = 0; i < result.message.length; i++) {
											self.emit('message', self.stripMessage(result.message[i]));
											}
										} else {
											self.emit('message', self.stripMessage(result.message));
										}
									} else if(result.iq) {
										if(self.iqCallbacks[result.iq['@'].id]) {
											self.iqCallbacks[result.iq['@'].id](result.iq);
										
											delete self.iqCallbacks[result.iq['@'].id];
										}
									}
								});
							
								parser.parseString("<x>" + d + "</x>");
							});
							
							ss.removeAllListeners('data');
							ss.addListener('data', function(x) { logger.trace("adding to the xml stream: %s", x.toString('utf8')); xmlStream.update(x); });
							
							self.presence(self.status.show, self.status.status, function() {}, false, true);
						}
					}
				});
			});
		}
	});

	var pushNotification = function(data) {
		if(this.lastId == data.id) {
			return;
		}
		this.lastId = data.id;
		
		var email = data.from.split('/')[0];
		
		if(self.rosterList[email]) {
			self.rosterList[email].jid = data.from;
		}
		
		if(!self.callback) {
			client.rpush('messages:' + self.key, util.crypto.cipher(JSON.stringify(data), self.userKey, 24));
			if(!self.unreadFor[email]) {
				self.unreadFor[email] = 1;
			} else {
				self.unreadFor[email]++;
			}
			self.unreadCount++;
			return;
		}

		if(self.sendRaw) {
			self.post(self.callback, "msg:" + util.crypto.cipher(JSON.stringify(data), self.userKey, 24), function(res) {
				var body = "";
				res.on('data', function(chunk) {
					body += chunk;
				}).on('end', function() {
					if(res.statusCode == 404) {
						// we must log off now
						self.logout(true);
					} else if(res.statusCode != 200) {
						logger.debug('error, disabling callback! HTTP %s', res.statusCode);
						logger.trace('mira los headers: %s', res.headers);
						logger.trace('y el body: %s', body);
						self.callback = undefined;
						
						self.persist();
					} else if(res.headers['x-notificationstatus'] == 'Suppressed') {
						if(self.sendToasts || self.sendTiles) {
							// switch to toast NOW
							logger.debug('notification suppressed, sending toast instead');
							self.sendRaw = false;
							pushNotification(data);
						} else {
							logger.debug('notification suppressed, disabling callback');
							
							self.callback = undefined();
							
							self.persist();
						}
					} else {
						logger.trace('another message sent: %s',  body);
					}
				});
			}, function(e) {
				logger.debug('error, disabling callback');
				logger.debug(e);
				self.callback = undefined;
				
				self.persist();
			});
		} else if(data.body) {
			var name = data.from.split('/')[0];
			
			client.rpush('messages:' + self.key, util.crypto.cipher(JSON.stringify(data), self.userKey, 24));
			
			if(!self.unreadFor[email]) {
				self.unreadFor[email] = 1;
			} else {
				self.unreadFor[email]++;
			}
			
			self.unreadCount++;

			if(self.rosterList[name] && self.rosterList[name].name) {
				name = self.rosterList[name].name;
			}

			logger.trace('the data %s', data);
			logger.trace('the name %s', name);

			var toast  = '<?xml version="1.0" encoding="utf-8"?>\n<wp:Notification xmlns:wp="WPNotification"><wp:Toast>';
			    toast += '<wp:Text1>' + xmlEscape(name) + '</wp:Text1><wp:Text2>' + xmlEscape(data.otr ? '(OTR)' : data.body) + '</wp:Text2>';
			    toast += '<wp:Param>/ChatPage.xaml?from=' + encodeURIComponent(data.from) + '</wp:Param></wp:Toast></wp:Notification>';
			
			var tile  = '<?xml version="1.0" encoding="utf-8"?>\n<wp:Notification xmlns:wp="WPNotification">';
				tile += '<wp:Tile><wp:Count>' + self.unreadCount + '</wp:Count></wp:Tile>';
				tile += '</wp:Notification>';
				
			var userTile  = '<?xml version="1.0" encoding="utf-8"?>\n<wp:Notification xmlns:wp="WPNotification">';
				userTile += '<wp:Tile Id="/ChatPage.xaml?from=' + encodeURIComponent(email) + '"><wp:Count>' + self.unreadFor[email] + '</wp:Count></wp:Tile>';
				userTile += '</wp:Notification>';

			logger.trace('gonna send some toast! %s', toast);
			logger.trace('gonna send some tile! %s', tile);
			
			var toastNotificationClass = '2',
			    tileNotificationClass = '1';
			
			if (self.status.status == 'away') {
				toastNotificationClass = '12';
				tileNotificationClass = '11';
			} else if(self.status.status == 'xa') {
				toastNotificationClass = '22';
				tileNotificationClass = '21';
			}
			
			var notifications = [
				[toast, {'X-NotificationClass': toastNotificationClass, 'X-WindowsPhone-Target': 'toast', 'Content-Type': 'text/xml'}],
				[tile, {'X-NotificationClass': tileNotificationClass, 'X-WindowsPhone-Target': 'token', 'Content-Type': 'text/xml'}],
				[userTile, {'X-NotificationClass': tileNotificationClass, 'X-WindowsPhone-Target': 'token', 'Content-Type': 'text/xml'}]
			];

			for(var i = 0; i < 3; i++) {
				if(notifications[i][1]['X-WindowsPhone-Target'] == 'toast' && !self.sendToasts) continue;
				if(notifications[i][1]['X-WindowsPhone-Target'] == 'token' && !self.sendTiles) continue;
				
				self.post(self.callback, notifications[i][0], function(res) {
					var body = "";
					res.on('data', function(chunk) {
						body += chunk;
					}).on('end', function() {
						if(res.statusCode == 404) {
							// we must log of now
							self.logout(true);
						} else if(res.statusCode != 200) {
							logger.debug('error, disabling callback! HTTP %s', res.statusCode);
							logger.trace('mira los headers: %s', res.headers);
							logger.trace('y el body: %s', body);
							self.callback = undefined;
							
							self.persist();
						} else {
							logger.trace('another message sent: %s',  body);
						}
					});
				}, function(e) {
					logger.debug('error, disabling callback');
					logger.debug(e);
					self.callback = undefined;
					
					self.persist();
				}, notifications[i][1]);
			}
		}
	};
	this.on('message', pushNotification);
	
	/*
	this.on('presence', function(data) {
		if(!self.callback || !self.sendRaw) return;
		
		self.post(self.callback, "pre:" + util.crypto.cipher(JSON.stringify(data), self.userKey, 24), function(res) {
			var body = "";
			res.on('data', function(chunk) {
				body += chunk;
			}).on('end', function() {
				logger.trace('mira los headers: %s', res.headers);

				if(res.statusCode != 200) {
					logger.debug('error, disabling callback!');
					self.callback = undefined;
					
					self.persist();
				} else if(res.headers['x-notificationstatus'] == 'Suppressed') {
					// switch to toast NOW
					self.sendRaw = false;
				} else {
					logger.trace('another message sent: %s',  body);
				}
			});
		}, function(e) {
			logger.debug('error, disabling callback');
			logger.debug(e);
			self.callback = undefined;
			
			self.persist();
		}, {'X-NotificationClass': '13'});
	});
	*/
};

gtalk.prototype.stripMessage = function(m) {
	var msg = {from: m['@'].from, time: new Date().getTime()};
	
	if(m['@'].id) msg.id = m['@'].id;
	if(m['@'].type) msg.type = m['@'].type;
	if(m['cha:composing']) msg.typing = true;
	if(m['cha:paused']) msg.typing = false;
	if(m.body) msg.body = m.body;
	if(m['nos:x']) msg.otr = m['nos:x']['@'].value == 'enabled';
	
	this.rosterList[msg.from.split("/")[0]].otr = msg.otr;
	
	return msg;
};

gtalk.prototype.stripPresence = function(p) {
	var pre = {jid: p['@'].from};
	var self = this;
	
	if(p['@'].type) pre.type = p['@'].type;
	if(p.show) pre.show = p.show;
	if(p.status && typeof(p.status) == 'string') pre.status = p.status;
	if(p.x && p.x.photo && typeof p.x.photo == 'string') {
		if(pre.photo != p.x.photo) {
			fs.stat('images/' + p.x.photo, function(err, stat) {
				if(err) {
					logger.info("downloading photo: %s", p.x.photo);
			
					self.photo(pre.jid, function(type, data) {
						fs.writeFile('images/' + p.x.photo, data, 'binary', function(err) {
							if(err) {
								logger.warn(err);
							}
						});
					});
				}
			});
		}
		pre.photo = p.x.photo;
	}
	
	if(!this.rosterList[pre.jid.split("/")[0]]) {
		this.rosterList[pre.jid.split("/")[0]] = pre;
	} else {
		var orig = this.rosterList[pre.jid.split("/")[0]];
		
		for(var x in pre) {
			if(typeof(pre[x]) == 'function') continue;
			
			orig[x] = pre[x];
		}
		
		if(!pre.type && orig.type) delete orig.type;
	}
	
	return pre;
};

gtalk.prototype.stripRoster = function(r) {
	var ros = {jid: r['@'].jid, type: 'unavailable'};
	
	if(r['@'].name) ros.name = r['@'].name;
	
	return ros;
};

gtalk.prototype.send = function(data, cb) {
	if(!this.disconnected) {
		try {
			this.sock.write(data, cb);
		} catch (err) {
			logger.critical("error writing stream. disconnecting ASAP: %s", err);
			this.logout(true);
		}
	}
};

gtalk.prototype.post = function(url, data, cb, ecb, extraHeaders) {
	var params = url.match(/(https?):\/\/([a-z0-9.-]+)(?::([0-9]+))?(\/.*)?$/);
	
	var buf = new Buffer(data);

	var options = {
		host: params[2],
		port: parseInt(params[3]),
		path: params[4],
		method: 'POST',
		headers: {'X-NotificationClass': '3', 'Content-Type': 'text/json', 'Content-Length': buf.length}
	};
	
	if(extraHeaders) {
		for(var h in extraHeaders) {
			if(typeof extraHeaders[h] != 'string') continue;
			
			options.headers[h] = extraHeaders[h];
		}
	}

	if(!options.port) {
		if(params[1] == 'http') options.port = 80;
		else options.port = 443;
	}

	if(!options.path) {
		options.path = '/';
	}
	
	if(params[1] == 'https') {
		options.cert = clientCert;
		options.key = clientKey;
	}

	if(params[1] == 'http') require('http').request(options, cb).on('error', ecb).end(buf);
	else require('https').request(options, cb).on('error', ecb).end(buf);
};

gtalk.prototype.message = function(to, body, cb) {
	var jid = to;
	
	if(jid.indexOf('/')) {
		jid = jid.split("/")[0]
	}
	
	if(!this.rosterList[jid]) {
		logger.warn('cannot send message to %s', jid);
	} else {
		if(this.rosterList[jid] && this.rosterList[jid].otr) {
			this.send("<message from='" + xmlEscape(this.jid) + "' to='" + xmlEscape(to) + "'><body>" + xmlEscape(body) + "</body><nos:x value='enabled' xmlns:nos='google:nosave' /><arc:record otr='true' xmlns:arc='http://jabber.org/protocol/archive' /></message>", cb);
		} else {
			this.send("<message from='" + xmlEscape(this.jid) + "' to='" + xmlEscape(to) + "'><body>" + xmlEscape(body) + "</body><nos:x value='disabled' xmlns:nos='google:nosave' /><arc:record otr='false' xmlns:arc='http://jabber.org/protocol/archive' /></message>", cb);
		}
	}
	
	this.presence(this.status.userset, this.status.status);
};

gtalk.prototype.presence = function(show, status, cb, userset, force) {
	var valid = ["available", "unavailable", "away", "chat", "dnd", "xa"],
	    self = this;
	
	if(valid.indexOf(show) == -1 || show == valid[0]) {
		show = undefined;
	}
	
	if(force || show != self.status.show || status != self.status.status) {	
		self.status.show = show;
		self.status.status = status;
	
		if(userset) {
			self.status.userset = show;
		}
		
		var msg;
	
		if(show == valid[1]) {
			msg = "<presence type='unavailable'";
		} else {
			msg = "<presence";
		}
	
		if(show || status) {
			msg += ">";
		
			if(show) {
				msg += "<show>" + show + "</show>";
			}
			if(status) {
				msg += "<status>" + xmlEscape(status) + "</status>";
			}
		
			msg += "</presence>";
		} else { 
			msg += " />";
		}
		
		self.send(msg, cb);
	}
	
	if(self.timer) {
		timers.clearTimeout(self.timer);
	}
	
	if(self.status.show == 'xa') {
		self.timer = timers.setTimeout(function() {
			self.logout(true);
		}, disconnectTimeout);
	} else if(self.status.show == 'away') {
		self.timer = timers.setTimeout(function() {
			self.presence('xa', self.status.status);
		}, xaTimeout);
	} else {
		self.timer = timers.setTimeout(function() {
			self.presence('away', self.status.status);
		}, awayTimeout);
	}
};

gtalk.prototype.roster = function(cb) {
	for(var username in this.rosterList) {
		if(typeof(username) != 'string' || typeof(this.rosterList[username]) == 'function') continue;
		
		cb(this.rosterList[username]);
	}
	
	cb(null);
};

gtalk.prototype.photo = function(jid, cb) {
	var id = "id_" + this.iqCounter++,
	    base64_decode = require("base64").decode;
	
	var msg = "<iq from='" + this.jid + "' to='" + xmlEscape(jid) + "' type='get' id='" + id + "'><vCard xmlns='vcard-temp'/></iq>";
	
	logger.trace("sending vcard request: %s", msg);
	
	this.iqCallbacks[id] = function(iq) {
		if(iq['@'].type == 'error' || !iq.vCard.PHOTO) {
			logger.warn("invalid vCard %s", iq.vCard);
			cb('error');
		} else {
			cb(iq.vCard.PHOTO.TYPE, base64_decode(iq.vCard.PHOTO.BINVAL));
		}
	};
	
	this.send(msg);
};

gtalk.prototype.otr = function(jid, enabled) {
	var email = jid.split("/")[0];
	
	if(!this.rosterList[email]) return;
	this.rosterList[email].otr = enabled;
	
	var id = "otr_" + this.iqCounter++;
	
	var msg = "<iq type='set' from='" + xmlEscape(this.jid) + "' to='" + xmlEscape(this.username) + "' id='" + id + "'><query xmlns='google:nosave'><item xmlns='google:nosave' jid='" + xmlEscape(email) + "' value='" + (enabled ? "enabled" : "disabled") + "'/></query></iq>";
	
	logger.trace("sending otr request: %s", msg);
	
	this.send(msg);
};

gtalk.prototype.notifications = function(jid, toast, tile) {
	this.sendToasts = toast;
	this.sendTiles = tile;
	
	this.persist();
};

gtalk.prototype.register = function(url) {
	this.callback = url;
	this.sendRaw = true;
	this.persist();
	
	this.presence(this.status.userset, this.status.status);
};

gtalk.prototype.messageQueue = function(cb) {
	var self = this;
	
	client.lrange('messages:' + self.key, 0, -1, function(err, messages) {
		if(messages == null) return;
		
		messages.forEach(function(msg) {
			logger.trace("sending a message", msg);
			cb(msg);
		});
		
		logger.trace("end of stream");
		cb(null);
		
		client.ltrim('messages:' + self.key, messages.length + 1, -1);
		self.unreadCount = 0;
		self.unreadFor = {};
	});
};

gtalk.prototype.logout = function(service) {
	var self = this;
	
	if(self.disconnected) return;
	this.disconnected = true;

	this.send("</stream:stream>", function() {
		self.sock.destroy();
	});
	
	client.srem('clients', self.clientId);
	client.del(self.clientId);
	
	if(service) {
		this.emit('disconnect');
	}
};

gtalk.prototype.persist = function() {
	client.set(this.clientId, util.crypto.cipher(JSON.stringify({
		key: this.key,
		clientId: this.clientId,
		token: this.token,
		username: this.username,
		auth: this.auth,
		callback: this.callback,
		status: this.status,
		unreadFor: this.unreadFor,
		sendTiles: this.sendTiles,
		sendToasts: this.sendToasts
	})));
};

function xmlEscape(str) {
	return str.replace(/&/g, '&amp;')
		.replace(/'/g, '&apos;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

module.exports.gtalk = function(token, username, auth) {
	return new gtalk(token, username, auth);
};

module.exports.initClientCert = function(ck, cc) {
	clientKey = ck;
	clientCert = cc;
}
