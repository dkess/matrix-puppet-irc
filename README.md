# matrix-puppet-irc

This is a [puppetted Matrix bridge](https://github.com/matrix-hacks/matrix-puppet-bridge) for IRC. It is intended to be used with a bouncer like irssi or ZNC.

## installation

clone this repo

cd into the directory

run `yarn` or `npm install`

## configure

Copy `config.sample.json` to `config.json` and update it to match your setup. To connect to multiple servers, clone this repo another time and configure it again.

## register the app service

Generate an `irc-registration.yaml` file with `node index.js -r -u "http://your-bridge-server:8090"`

Note: The 'registration' setting in the config.json needs to set to the path of this file. By default, it already is.

Copy this `irc-registration.yaml` file to your home server. Make sure that from the perspective of the homeserver, the url is correctly pointing to your bridge server. e.g. `url: 'http://your-bridge-server.example.org:8090'` and is reachable.

Edit your homeserver.yaml file and update the `app_service_config_files` with the path to the `irc-registration.yaml` file.

Launch the bridge with ```node index.js```.

Restart your HS.

## Bugs
* Received PMs go to the server status window, and cannot be responded to.
* If the user quits, gets kicked, or leaves a channel, it is not shown on the Matrix side.
