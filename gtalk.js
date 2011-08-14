var logger = require('./log').log('gtalk'),
    fs = require('fs'),
    util = require('./util'),
    timers = require('timers'),
    redis = require("redis"),
	dns = require('dns'),
    client = redis.createClient();

var awayTimeout = 15 * 60 * 1000; // 15 min
var xaTimeout = 15 * 60 * 1000; // 30 min
var disconnectTimeout = 90 * 60 * 1000; // 2h

var clientCert = undefined;
var clientKey = undefined;

var lastId = {};

function gtalk(token, username, auth) {
	logger.trace('instantiating with %s, %s %s', token, username, auth);
	
	if(typeof(token) == 'object') {
		this.clientId = token.clientId;
		this.token = token.token;
		this.username = token.username;
		this.auth = token.auth;
		this.callback = token.callback;
		this.status = token.status;
		this.unreadFor = token.unreadFor;
		this.key = token.key;
		this.sendToasts = token.sendToasts;
		this.sendTiles = token.sendTiles;
		this.sendSecondaryTiles = token.sendSecondaryTiles;
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
		this.status = {status: "", show: ""};
		this.unreadFor = {};
		this.sendToasts = true;
		this.sendTiles = true;
		this.sendSecondaryTiles = true;
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
	this.jingle = [];
	
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
						var token = base64_encode(new Buffer('\u0000' + self.username + '\u0000' + self.auth));
						ss.write("<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='X-GOOGLE-TOKEN'>" + token + "</auth>");
					} else if(str.indexOf('failure') != -1) {
						self.emit('auth_failure', str);
						logger.debug('auth_failure: %s', str);
						self.logout();
					} else if(str.indexOf('success') != -1) {
						self.logged_in = true;
						
						client.sadd('clients', self.clientId);
						self.persist();
						
						var xmlStream = new util.XmlStream();
						
						var loginSteps = [
							{
								id: 'bind_resource',
								send: function() {
									ss.write("<iq type='set' id='bind_resource'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><resource>gchat.</resource></bind></iq>");
								},
								receive: function(result) {
									self.jid = result.bind.jid;
									self.username = self.jid.split('/')[0];
								}
							}, {
								id: 'session',
								send: function() {
									ss.write("<iq to='" + self.server + "' type='set' id='session'><session xmlns='urn:ietf:params:xml:ns:xmpp-session'/></iq>");
								}
							/*
							}, {
								id: 'disco',
								send: function() {
									ss.write("<iq from='" + self.jid + "' id='disco' to='gchatwptest@gmail.com/gmail.78A161E7' type='get'><query xmlns='http://jabber.org/protocol/disco#info' node='http://mail.google.com/xmpp/client/caps#1.1'/></iq>");
								},
								receive: function(result) {
									logger.debug("disco %s", result);
								}
							*/
							}, {
								id: 'roster',
								send: function() {
									ss.write("<iq from='" + self.jid + "' type='get' id='roster'><query xmlns='jabber:iq:roster'/></iq>");
								},
								receive: function(result) {								
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
								}
							}, {
								id: 'shared-status',
								send: function() {
									ss.write("<iq type='get' to='" + self.username + "' id='shared-status'><query xmlns='google:shared-status' version='2'/></iq>");
								}
							}, {
								id: 'jingle-info',
								send: function() {
									ss.write("<iq type='get' to='" + self.username + "' id='jingle-request'><query xmlns='google:jingleinfo'/></iq>");
								}
							}, {
								send: function() {
									self.presence(self.status.show, self.status.status, function() {}, false, true);
								}
							}
						];
						
						xmlStream.addListener('data', function(result) {
							if(result['stream:stream']) {
								// do the login dance
								var loginDance = function(idx) {
									logger.trace('login dance step %s: %s', idx, loginSteps[idx]);
									
									if(loginSteps[idx].id) {
										self.iqCallbacks[loginSteps[idx].id] = function(result) {
											if(loginSteps[idx].receive) {
												loginSteps[idx].receive(result);
											}
											loginDance(idx+1);
										};
									}
									loginSteps[idx].send();
								};
								loginDance(0);
							} else if(result.presence) {
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
								if(result.iq.query && result.iq.query['@']) {
									switch(result.iq.query['@'].xmlns) {
										case 'google:shared-status':
											logger.trace("shared status: %s", result);
											logger.trace("shared status xml: %s", util.xmlify('iq', result.iq));
											
											if(result.iq.query.show) {
												self.status.show = result.iq.query.show;
												self.status.status = result.iq.query.status;
												
												if(typeof(self.status.status) == 'object') {
													self.status.status = '';
												}
												
												if(self.status.show == 'default') {
													self.status.show = 'available';
												}
											
												self.status.userset = self.status.show;
											}
											
											break;
										case 'google:jingleinfo':
											var servers = result.iq.query.stun.server;
											
											self.jingle = [];
											
											for(var i = 0; i < servers.length; i++) {
												(function(port) {
													dns.resolve(servers[i]['@'].host, function(err, addresses) {
														if(!err) {
															self.jingle.push({host: addresses[0], udp: port});
														}
													});
												})(servers[i]['@'].udp);
											}
											
											break;
									}
								}
								
								if(result.iq.session || result.iq['ses:session']) {
									logger.debug('session < %s', util.xmlify('iq', result.iq));
									self.emit('session', result.iq);
								}
								
								if(self.iqCallbacks[result.iq['@'].id]) {
									self.iqCallbacks[result.iq['@'].id](result.iq);
								
									delete self.iqCallbacks[result.iq['@'].id];
								}
							}
						});
						
						ss.removeAllListeners();
						ss.addListener('data', function(x) {
							//logger.trace("adding to the xml stream: %s", x.toString('utf8') );
							xmlStream.update(x);
						});
						ss.addListener('error', function(x) {
							logger.critical('An error ocurred on the SSL socket: %s', x);
							self.logout(true);
						});
						
						ss.write("<stream:stream to='" + self.server + "' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>");
					}
				});
			});
		}
	});

	var pushNotification = function(data) {
		var email = data.from.split('/')[0];
		
		if(self.disconnected || lastId[self.key] == data.id) {
			return;
		}
		lastId[self.key] = data.id;
		
		if(!self.callback) {
			client.rpush('messages:' + self.key, util.crypto.cipher(JSON.stringify(data), self.userKey, 24));
			if(typeof self.unreadFor[email] !== 'undefined') {
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
						if(self.sendToasts || self.sendTiles || self.sendSecondaryTiles) {
							// switch to toast NOW
							logger.debug('notification suppressed, sending toast instead');
							logger.debug('headers %s', res.headers);
							logger.debug('body %s', body);
							self.sendRaw = false;
							
							lastId[self.key] = undefined;
							pushNotification(data);
						} else {
							logger.debug('notification suppressed, disabling callback');
							logger.debug('headers %s', res.headers);
							logger.debug('body %s', body);
							
							self.callback = undefined;
							
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
			
			if(typeof self.unreadFor[email] !== 'undefined') {
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
			
			var notifications = [];
			
			if(self.sendToasts) notifications.push([toast, {'X-NotificationClass': toastNotificationClass, 'X-WindowsPhone-Target': 'toast', 'Content-Type': 'text/xml'}]);
			if(self.sendTiles) notifications.push([tile, {'X-NotificationClass': tileNotificationClass, 'X-WindowsPhone-Target': 'token', 'Content-Type': 'text/xml'}]);
			if(self.unreadFor[email] > 0 && self.sendSecondaryTiles) {
				logger.debug('gonna send this tile! %s', tile);
				notifications.push([userTile, {'X-NotificationClass': tileNotificationClass, 'X-WindowsPhone-Target': 'token', 'Content-Type': 'text/xml'}]);
			}

			for(var i = 0; i < notifications.length; i++) {
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
							logger.debug('mira los headers: %s', res.headers);
							logger.debug('y el body: %s', body);
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
	
	var sessionNotification = function(data) {
		if(self.disconnected || !self.callback || !self.sendRaw) {
			var id = "iq_" + self.iqCounter++;
			
			self.send("<iq type='set' to='" + data['@'].from + "' id='" + id + "' from='" + self.jid + "'><ses:session type='reject' id='" + (data['ses:session'] || data.session)['@'].id + "' initiator='" + data['@'].from + "' xmlns:ses='http://www.google.com/session'/></iq>");
			return;
		}

		util.crypto.cipher(util.xmlify('iq', data), self.userKey, 24, function(payload) {
			payload = 'iq:' + payload;
			self.post(self.callback, payload, function(res) {
				var body = "";
				res.on('data', function(chunk) {
					body += chunk;
				}).on('end', function() {
					var sent = false;
					
					if(res.statusCode == 404) {
						// we must log off now
						self.logout(true);
					} else if(res.statusCode != 200) {
						logger.debug('error, disabling session callback! HTTP %s', res.statusCode);
						logger.debug('mira los headers: %s', res.headers);
						logger.debug('y el body: %s', body);
						logger.debug('y el payload: %s', payload);
						self.callback = undefined;
						
						self.persist();
					} else if(res.headers['x-notificationstatus'] == 'Suppressed') {
						if(self.sendToasts || self.sendTiles || self.sendSecondaryTiles) {
							// switch to toast NOW
							logger.debug('notification suppressed, sending toast instead');
							logger.debug('headers %s', res.headers);
							logger.debug('body %s', body);
							self.sendRaw = false;
						} else {
							logger.debug('notification suppressed, disabling callback');
							
							self.callback = undefined;
							
							self.persist();
						}
					} else {
						sent = true;
					}
					
					if(!sent) {						
						var id = "iq_" + (self.iqCounter++);
						self.send("<iq type='set' to='" + data['@'].from + "' id='" + id + "' from='" + self.jid + "'><ses:session type='reject' id='" + (data['ses:session'] || data.session)['@'].id + "' initiator='" + data['@'].from + "' xmlns:ses='http://www.google.com/session'/></iq>");
					}
				});
			}, function(e) {
				logger.debug('error, disabling callback');
				logger.debug(e);
				self.callback = undefined;
				
				self.persist();
				
				var id = "iq_" + (self.iqCounter++);
				self.send("<iq type='set' to='" + data['@'].from + "' id='" + id + "' from='" + self.jid + "'><ses:session type='reject' id='" + (data['ses:session'] || data.session)['@'].id + "' initiator='" + data['@'].from + "' xmlns:ses='http://www.google.com/session'/></iq>");
			});
		});
	};
	this.on('session', sessionNotification);
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
	var jid = p['@'].from,
	    email = jid.split("/")[0],
		pre = {jid:email},
	    self = this,
		offline = p['@'].type == 'unavailable';
	
	if(p.show) pre.show = p.show;
	if(typeof(p.status) == 'string') pre.status = p.status;
	if(p['caps:c'] && p['caps:c']['@']['ext']) pre.caps = p['caps:c']['@']['ext'].split(' ');
	
	if(offline) {
		if(this.rosterList[email] && this.rosterList[email].sessions[jid]) {
			delete this.rosterList[email].sessions[jid];
		}
	} else {
		if(!this.rosterList[email]) {
			this.rosterList[email] = {jid:email, sessions:{}};
		}
		this.rosterList[email].sessions[jid] = pre;
	}
	
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
		
		this.rosterList[email].photo = p.x.photo;
	}
	
	return pre;
};

gtalk.prototype.stripRoster = function(r) {
	var ros = {jid: r['@'].jid, sessions: {}};
	
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
	
	var buf = new Buffer("" + data);

	var options = {
		host: params[2],
		port: parseInt(params[3]),
		path: params[4],
		method: 'POST',
		headers: {'X-NotificationClass': '3', 'Content-Type': 'text/plain', 'Content-Length': buf.length}
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
			this.send("<message type='chat' from='" + xmlEscape(this.jid) + "' to='" + xmlEscape(to) + "'><active xmlns='http://jabber.org/protocol/chatstates'/><body>" + xmlEscape(body) + "</body><nos:x value='enabled' xmlns:nos='google:nosave' /><arc:record otr='true' xmlns:arc='http://jabber.org/protocol/archive' /></message>", cb);
		} else {
			this.send("<message type='chat' from='" + xmlEscape(this.jid) + "' to='" + xmlEscape(to) + "'><active xmlns='http://jabber.org/protocol/chatstates'/><body>" + xmlEscape(body) + "</body><nos:x value='disabled' xmlns:nos='google:nosave' /><arc:record otr='false' xmlns:arc='http://jabber.org/protocol/archive' /></message>", cb);
		}
	}
	
	this.presence(this.status.userset, this.status.status);
};

gtalk.prototype.rawiq = function(id, body, cb) {
	if(id) {
		this.iqCallbacks[id] = function(iq) {
			cb(iq);
		};
	} else {
		cb();
	}
	
	logger.debug('session > %s', body);
	
	this.send(body);
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
			msg = "<presence type='unavailable'>";
		} else {
			msg = "<presence>";
		}
	
		if(show) {
			msg += "<show>" + show + "</show>";
		}
		if(status) {
			msg += "<status>" + xmlEscape(status) + "</status>";
		}
		
		msg += '<caps:c node="http://mail.google.com/xmpp/client/caps" ver="1.1" ext="voice-v1" xmlns:caps="http://jabber.org/protocol/caps" />';
		msg += '</presence>';
		
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
		if(!this.rosterList.hasOwnProperty(username)) continue;
		
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
			logger.warning("invalid vCard %s", iq.vCard);
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

gtalk.prototype.notifications = function(jid, toast, tile, secondarytile) {
	this.sendToasts = toast;
	this.sendTiles = tile;
	this.sendSecondaryTiles = tile;
	
	this.persist();
};

gtalk.prototype.register = function(url, tiles) {
	this.callback = url;
	this.sendRaw = true;
	
	try {
		tiles = JSON.parse(tiles);
	} catch(e) {
		tiles = undefined;
	}
	
	if(Array.isArray(tiles)) {
		var remove = {};
		for(var email in this.unreadFor) {
			if(this.unreadFor.hasOwnProperty(email)) {
				remove[email] = true;
			}
		}
		
		for(var i = 0; i < tiles.length; i++) {
			if(typeof(this.unreadFor[tiles[i]]) === 'undefined') {
				this.unreadFor[tiles[i]] = 0;
				remove[tiles[i]] = false;
			}
		}
		
		for(var email in remove) {
			if(remove[email] === true) {
				delete this.unreadFor[email];
			}
		}
	}
	
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
		for(var email in self.unreadFor) {
			if(!self.unreadFor.hasOwnProperty(email)) continue;
			
			self.unreadFor[email] = 0;
		}
	});
};

gtalk.prototype.logout = function(service) {
	var self = this;
	
	if(self.disconnected) return;
	self.disconnected = true;

	self.sock.removeAllListeners();
	self.sock.end("</stream:stream>", function() {
		self.sock.destroy();
	});
	
	client.srem('clients', self.clientId);
	client.del(self.clientId);
	
	if(service) {
		self.emit('disconnect');
	}
};

gtalk.prototype.persist = function() {
	if(this.disconnected) return;
	
	client.set(this.clientId, util.crypto.cipher(JSON.stringify({
		key: this.key,
		clientId: this.clientId,
		token: this.token,
		username: this.username,
		auth: this.auth,
		callback: this.callback,
		status: this.status,
		unreadFor: this.unreadFor,
		sendToasts: this.sendToasts,
		sendTiles: this.sendTiles,
		sendSecondaryTiles: this.sendSecondaryTiles
	})));
};

function xmlEscape(str) {
	if(!str) return "";
	
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
