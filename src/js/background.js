/* Shortcut for chrome.storage.local api */
var storage = chrome.storage.local;

/* Browser Detection */
var isFirefox = typeof InstallTrigger !== 'undefined';

/* On Install */
chrome.runtime.onInstalled.addListener(details => {
	if (details.reason === 'update') {
		createNotification('LISTEN.moe', `Extension has updated to v${chrome.runtime.getManifest().version}`);
	}
});

const radioType = {
	JPOP: {
		stream: 'https://listen.moe/stream',
		gateway: 'wss://listen.moe/gateway_v2'
	},
	KPOP: {
		stream: 'https://listen.moe/kpop/stream',
		gateway: 'wss://listen.moe/kpop/gateway_v2'
	}
};

/* Storage Items */
var storageItems = {};

/* Gets stored values if any and applies them */
storage.get({
	volume: 50,
	enableAutoplay: false,
	enableNotifications: true,
	enableEventNotifications: true,
	radioType: 'JPOP'
}, items => {
	if (typeof items.volume !== 'undefined') {
		radio.setVol(items.volume);
	}

	if (items.enableAutoplay) {
		radio.enable();
	}

	storageItems = items;

	radio.socket.init();
});

chrome.storage.onChanged.addListener(changes => {
	for (let item in changes) {
		storageItems[item] = changes[item].newValue;
		if (item === 'radioType') {
			radio.socket.ws.close(4069, 'Closed to switch radio type');
			if (radio.player.getAttribute('src')) {
				radio.player.setAttribute('src', radioType[storageItems.radioType].stream);
			}
		}
	}
});

/* Radio Functions */

var radio = {
	player: createElement('audio', {
		id: 'listen-moe',
		autoplay: true
	}),
	enable() {
		return this.player.setAttribute('src', radioType[storageItems.radioType].stream);
	},
	disable() {
		return this.player.setAttribute('src', '');
	},
	toggle() {
		return this.isPlaying ? this.disable() : this.enable();
	},
	toggleType() {
		return new Promise(resolve => {
			const type = storageItems.radioType === 'JPOP' ? 'KPOP' : 'JPOP';
			storage.set({ radioType: type }, () => {
				resolve(type);
			});
		});
	},
	get isPlaying() {
		return !this.player.paused;
	},
	setVol(volume) {
		if (Number.isInteger(volume) && (volume >= 0 || volume <= 100)) {
			this.player.volume = volume / 100;
			storage.set({ volume });
		}
	},
	get getVol() {
		return this.player.volume * 100;
	},
	data: {},
	token: null,
	socket: {
		ws: null,
		event: new Event('songChanged'),
		data: { lastSongID: -1 },
		init() {

			radio.socket.ws = new WebSocket(radioType[storageItems.radioType].gateway);

			radio.socket.ws.onopen = () => {
				console.info('%cWebsocket connection established.', 'color: #ff015b;');
				clearInterval(radio.socket.sendHeartbeat);
			};

			radio.socket.ws.onerror = err => {
				console.error(err);
			};

			radio.socket.ws.onclose = err => {
				console.info('%cWebsocket connection closed. Reconnecting...', 'color: #ff015b;', err.reason);
				clearInterval(radio.socket.sendHeartbeat);
				setTimeout(radio.socket.init, err.code === 4069 ? 500 : 5000);
			};

			radio.socket.ws.onmessage = async message => {

				if (!message.data.length) return;

				let response;

				try {
					response = JSON.parse(message.data);
				} catch (err) {
					console.error(err);
					return;
				}

				if (response.op === 0) {
					radio.socket.heartbeat(response.d.heartbeat);
					return;
				}

				if (response.op === 1) {

					if (response.t !== 'TRACK_UPDATE' && response.t !== 'TRACK_UPDATE_REQUEST') return;

					radio.data = response.d;

					radio.data.song.favorite = await radio.checkFavorite(radio.data.song.id);

					radio.player.dispatchEvent(radio.socket.event);

					if (radio.data.song.albums.length && radio.data.song.albums[0].image) {

						const cover = await fetch(`https://cdn.listen.moe/covers/${radio.data.song.albums[0].image}`).then(data => data.blob());

						const fileReader = new FileReader();

						fileReader.onload = e => {
							radio.data.song.coverData = e.target.result;
						};

						fileReader.readAsDataURL(cover);

					} else {

						radio.data.song.coverData = null;

					}

					if (radio.data.song.id !== radio.socket.data.lastSongID) {

						if (radio.socket.data.lastSongID !== -1 && radio.isPlaying && storageItems.enableNotifications) {
							createNotification('Now Playing', radio.data.song.title, radio.data.song.artists.map(a => a.nameRomaji || a.name).join(', '), false, !!radio.token);
						}

						radio.socket.data.lastSongID = radio.data.song.id;

					}

				}

			};

		},
		heartbeat(heartbeat) {
			radio.socket.sendHeartbeat = setInterval(() => {
				radio.socket.ws.send(JSON.stringify({ op: 9 }));
			}, heartbeat);
		}
	},
	toggleFavorite() {
		return new Promise((resolve, reject) => {
			if (!radio.token) return;

			const headers = new Headers({
				Authorization: `Bearer ${radio.token}`,
				'Content-Type': 'application/json'
			});

			const { id } = radio.data.song;

			fetch('https://listen.moe/graphql', {
				method: 'POST', headers,
				body: JSON.stringify({
					operationName: 'favoriteSong',
					query: `
						mutation favoriteSong($id: Int!) {
							favoriteSong(id: $id) {
								id
							}
						}
					`,
					variables: { id }
				})
			})
				.then(res => res.json())
				.then(data => {
					if (data.data) {
						radio.data.song.favorite = !radio.data.song.favorite;
						radio.player.dispatchEvent(radio.socket.event);
						resolve(radio.data.song.favorite);
					} else if (data.errors) {
						console.error(data.errors);
						reject(data.errors);
					}
				})
				.catch(err => {
					reject(err);
				});

		});
	},
	checkFavorite(id) {
		return new Promise(resolve => {
			if (!radio.token) {
				resolve(false);
				return;
			}

			const headers = new Headers({
				Authorization: `Bearer ${radio.token}`,
				'Content-Type': 'application/json'
			});

			const songs = [radio.data.song.id];

			fetch('https://listen.moe/graphql', {
				method: 'POST', headers,
				body: JSON.stringify({
					operationName: 'checkFavorite',
					query: `
						query checkFavorite($songs: [Int!]!) {
  							checkFavorite(songs: $songs)
						}
					`,
					variables: { songs }
				})
			})
				.then(res => res.json())
				.then(data => {
					if (data.data) {
						resolve(data.data.checkFavorite.includes(id));
					} else if (data.errors) {
						console.error(data.errors);
						resolve(false);
					}
				})
				.catch(err => {
					console.error(err);
					resolve(false);
				});
		});
	}
};

/* Get token */

chrome.cookies.onChanged.addListener(details => {
	if (details.cookie.name === 'token') {
		if (details.removed) {
			radio.token = null;
		} else {
			radio.token = details.cookie.value;
		}
	}
});

chrome.cookies.get({
	url: 'https://listen.moe',
	name: 'token'
}, data => {
	radio.token = data ? data.value : null;
});

/* Keyboard Shortcuts */

chrome.commands.onCommand.addListener(command => {
	if (command === 'toggle_radio') {
		radio.toggle();
	} else if (command === 'vol_up') {
		radio.getVol > 95
			? radio.setVol(100)
			: radio.setVol(Math.floor(radio.getVol + 5));
	} else if (command === 'vol_down') {
		radio.getVol < 5
			? radio.setVol(0)
			: radio.setVol(Math.floor(radio.getVol - 5));
	} else if (command === 'now_playing') {
		createNotification('Now Playing', radio.data.song.title, radio.data.song.artists.map(a => a.nameRomaji || a.name).join(', '), false, !!radio.token);
	} else if (command === 'toggle_type') {
		radio.toggleType();
	}
});

/* Modify Request Header to change UserAgent */
chrome.webRequest.onBeforeSendHeaders.addListener(details => {
	if (details.tabId === -1) {
		for (let header of details.requestHeaders) {
			if (header.name === 'User-Agent') {
				header.value = `${chrome.runtime.getManifest().name} ${isFirefox ? 'Firefox' : 'Chrome'} Extension v${chrome.runtime.getManifest().version} (https://github.com/LISTEN-moe/browser-extension)`;
			}
		}
	}
	return { requestHeaders: details.requestHeaders };
}, {
	urls: [
		'*://listen.moe/graphql',
		'*://listen.moe/stream',
		'*://listen.moe/kpop/stream'
	]
}, ['blocking', 'requestHeaders']);

function createNotification(title, message, altText, sticky, showFavoriteButton) {

	if (!title || !message) return;

	const iconUrl = title === 'Now Playing'
		? radio.data.song.coverData || 'images/logo128.png'
		: 'images/logo128.png';

	let notificationContent = {
		type: 'basic',
		title, message, iconUrl
	};

	if (!isFirefox) {
		notificationContent.requireInteraction = sticky || false;
	}

	if (altText && typeof altText === 'string') {
		/* Firefox does not have contentMessage support yet. */
		if (isFirefox) {
			notificationContent.message += `\n ${altText}`;
		} else {
			notificationContent.contextMessage = altText;
		}
	}

	if (!isFirefox && showFavoriteButton) {
		notificationContent.buttons = [{ title: radio.data.song.favorite ? 'Remove from Favorites' : 'Add to Favorites' }];
	}

	chrome.notifications.create(`notification_${Date.now()}`, notificationContent);

}

chrome.notifications.onButtonClicked.addListener(id => {
	radio.toggleFavorite().then(favorited => {
		chrome.notifications.clear(id);
		createNotification('Updated Favorites!', `${favorited ? 'Added' : 'Removed'} '${radio.data.song.title}' ${favorited ? 'to' : 'from'} favorites!`);
	}).catch(() => {
		chrome.notifications.clear(id);
		createNotification('Error Updating Favorites!', 'An error has occured while trying to update your favorites!');
	});
});

chrome.notifications.onClicked.addListener(id => {
	chrome.notifications.clear(id);
});

function createElement(tag, attrs, styles) {
	let element = document.createElement(tag);
	for (let key in attrs) {
		element.setAttribute(key, attrs[key]);
	}
	for (let key in styles) {
		element.style[key] = styles[key];
	}
	return element;
}
