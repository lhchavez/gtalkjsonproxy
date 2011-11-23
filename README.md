GTalkJsonProxy is released under the terms of the [CC BY-NC-SA license](http://creativecommons.org/licenses/by-nc-sa/3.0/).

# Setup dev environment

## Prerequisites:

* npm
* node.js
* redis

## Install dependencies:

    npm install base64
    npm install xml2js
    npm install gzip
    npm install redis

## Generate certificates

Generate the server key, self-sign it, then remove the passphrase.

    openssl genrsa -aes256 -out server.key-pass 1024
    openssl req -new -key server.key-pass -out server.csr
    openssl x509 -req -days 365 -in server.csr -signkey server.key-pass -out server.crt
    openssl rsa -in server.key-pass -out server.key
    rm server.csr 

Repeat the above for the client key, conveniently named `client.key`.

Finally, generate a key used for encrypting stuff in-memory.

    openssl genrsa -aes256 -out crypto.key-pass 1024
    openssl rsa -in crypto.key-pass -out crypto.key

## Create an unprivileged user to run the server

    useradd -M -d $PWD gtalk

# Running the server

Start redis, run `sudo node service.js`.

