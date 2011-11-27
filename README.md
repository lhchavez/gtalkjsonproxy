GTalkJsonProxy is released under the terms of the [CC BY-NC-SA license][1].

# What is it?

This is the JSON proxy used by the [Gchat][2] app to talk to the GoogleTalk IM
service. Its client API is JSON over HTTP, which is translates into XMPP to
send to Google. Crucially, the connection is maintained on the server side and
messages are sent to the phone app using Microsoft's push notification server.

Although it's currently tightly bound to Microsoft's push notification system,
this server could be adapted to run battery-friendly IM clients on iOS or
Android. Likewise, the GoogleTalk specific stuff can be stripped out to make a
generic XMPP proxy.

# How can I hack it?

## Prerequisites:

* node
* npm
* redis

## Install dependencies:

    npm install base64
    npm install xml2js
    npm install gzip
    npm install redis

## Generate certificates

Generate the server certificate, self-sign it, then remove the passphrase. This
is the certificate presented to connecting clients. Its cn should match your
host name.

    openssl genrsa -aes256 -out server.key-pass 1024
    openssl req -new -key server.key-pass -out server.csr
    openssl x509 -req -days 365 -in server.csr -signkey server.key-pass -out server.crt
    openssl rsa -in server.key-pass -out server.key
    rm server.csr 

Repeat the above for the client key, conveniently named `client.key`.

    openssl genrsa -aes256 -out client.key-pass 1024
    openssl req -new -key client.key-pass -out client.csr
    openssl x509 -req -days 365 -in client.csr -signkey client.key-pass -out client.crt
    openssl rsa -in client.key-pass -out client.key
    rm client.csr 

Finally, generate a key used to encrypting the stuff that gets stored in redis.

    openssl genrsa -aes256 -out crypto.key-pass 1024
    openssl rsa -in crypto.key-pass -out crypto.key

## Create an unprivileged user to run the server

    useradd -M -d $PWD gtalk

# Running the server

Start redis, run `sudo node service.js`. The server binds to port 443, then
drops superuser privs.

# Testing the server

Fire POST requests at the URL. There's currently no protocol specification, but
the protocol can be distilled from [GoogleTalk.cs][3] in the client project.
Use your favorite requests library or install the Windows Phone SDK and build
the client app.

  [1]: http://creativecommons.org/licenses/by-nc-sa/3.0/
  [2]: https://github.com/lhchavez/gtalkchat/
  [3]: https://github.com/lhchavez/gtalkchat/blob/master/Gchat/Protocol/GoogleTalk.cs

