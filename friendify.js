(async function () {
  while (
    !Spicetify ||
    !Spicetify.React ||
    !Spicetify.ReactDOM ||
    !Spicetify.Platform ||
    !Spicetify.Topbar
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const { createElement, useState, useEffect } = Spicetify.React;

  class ActivityManager {
    static queueFriendIDs = [];
    static playlistFriendIDs = [];
    static friendPlaylists = {};

    static loadConfig() {
      const queueData = Spicetify.LocalStorage.get("queueFriendIDs");
      const playlistData = Spicetify.LocalStorage.get("playlistFriendIDs");

      this.queueFriendIDs = queueData ? JSON.parse(queueData) : [];
      this.playlistFriendIDs = playlistData ? JSON.parse(playlistData) : [];
    }

    static saveConfig() {
      Spicetify.LocalStorage.set("queueFriendIDs", JSON.stringify(this.queueFriendIDs));
      Spicetify.LocalStorage.set("playlistFriendIDs", JSON.stringify(this.playlistFriendIDs));
    }

    static async beginTracking() {
      while (!Spicetify.Platform.BuddyFeedAPI || !Spicetify.CosmosAsync) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      const friends = await ActivityManager.fetchFriendList();
      const friendIDs = friends.map((friend) => friend.user.uri.split(":")[2]);

      friendIDs.forEach((friendID) => {
        Spicetify.Platform.BuddyFeedAPI.subscribeToBuddyActivity(friendID, (event) => {
          ActivityManager.handleEvent(event, friendID);
        });
      });
    }

    static async fetchFriendList() {
      while (!Spicetify.CosmosAsync || !Spicetify.CosmosAsync.get) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      const { friends } = await Spicetify.CosmosAsync.get(
        "https://spclient.wg.spotify.com/presence-view/v1/buddylist"
      );
      return friends.reverse();
    }

    static displayNotification(message) {
      Spicetify.showNotification(message);
    }

    static async handleEvent(event, friendID) {
      const trackUri = event.track.uri;
      if (this.queueFriendIDs.includes(friendID)) {
        try {
          await Spicetify.Platform.PlayerAPI.addToQueue([{ uri: trackUri, uid: null }]);
        } catch (error) {
        }
      }
      if (this.playlistFriendIDs.includes(friendID)) {
        try {
          const friendName = event.user.name;
          const playlistUri = await this.obtainPlaylistForFriend(friendID, friendName);

          const exists = await this.checkTrackInPlaylist(playlistUri, trackUri);
          if (!exists) {
            await Spicetify.CosmosAsync.post(
              `https://api.spotify.com/v1/playlists/${playlistUri.split(":")[2]}/tracks`,
              { uris: [trackUri] }
            );
            this.displayNotification(`Added to playlist: ${event.track.name}`);
          }
        } catch (error) {
        }
      }
    }

    static async obtainPlaylistForFriend(friendID, friendName) {
      if (this.friendPlaylists[friendID]) {
        return this.friendPlaylists[friendID];
      }
      const playlistName = `FriendID: ${friendID}`;
      try {
        let playlists = [];
        let nextUrl = "https://api.spotify.com/v1/me/playlists?limit=50";
        while (nextUrl) {
          const response = await Spicetify.CosmosAsync.get(nextUrl);
          playlists = playlists.concat(response.items);
          nextUrl = response.next;
        }
        let playlist = playlists.find((pl) => pl.name === playlistName);
        if (!playlist) {
          playlist = await Spicetify.CosmosAsync.post("https://api.spotify.com/v1/me/playlists", {
            name: playlistName,
            description: `Tracks listened by ${friendName}`,
            public: false,
          });

          await Spicetify.CosmosAsync.put(
            `https://api.spotify.com/v1/playlists/${playlist.id}`,
            { public: false }
          );
        }

        this.friendPlaylists[friendID] = playlist.uri;
        return playlist.uri;
      } catch (error) {
      }
    }

    static async checkTrackInPlaylist(playlistUri, trackUri) {
      try {
        const playlistId = playlistUri.split(":")[2];
        let items = [];
        let nextUrl = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?fields=items(track(uri)),next&limit=100`;

        while (nextUrl) {
          const response = await Spicetify.CosmosAsync.get(nextUrl);
          items = items.concat(response.items);
          nextUrl = response.next;
        }

        return items.some((item) => item.track.uri === trackUri);
      } catch (error) {
        return false;
      }
    }

    static toggleQueueOption(friendID) {
      if (this.queueFriendIDs.includes(friendID)) {
        this.queueFriendIDs = this.queueFriendIDs.filter((id) => id !== friendID);
      } else {
        this.queueFriendIDs.push(friendID);
      }
      this.saveConfig();
    }

    static togglePlaylistOption(friendID) {
      if (this.playlistFriendIDs.includes(friendID)) {
        this.playlistFriendIDs = this.playlistFriendIDs.filter((id) => id !== friendID);
      } else {
        this.playlistFriendIDs.push(friendID);
      }
      this.saveConfig();
    }

    static async insertSettingsControl() {
      while (!Spicetify.Topbar || !Spicetify.React || !Spicetify.PopupModal) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const { createElement } = Spicetify.React;

      const buttonIconHTML = `<svg role="img" height="19" width="19" viewBox="0 0 15 15" fill="currentColor">${Spicetify.SVGIcons.heart}</svg>`;

      const btn = new Spicetify.Topbar.Button(
        "Friendify Activities",
        buttonIconHTML,
        () => {
          Spicetify.PopupModal.display({
            title: "Friendify",
            content: createElement(SettingsPanel),
            isLarge: true,
          });
        },
        false
      );

      btn.element.id = "friendify-button";
      
    }
  }
  function SettingsPanel() {
    const [friends, setFriends] = useState([]);
    const [, forceUpdate] = useState(0);
  
    useEffect(() => {
      const fetchFriends = async () => {
        const friendsList = await ActivityManager.fetchFriendList();
        
        if (ActivityManager.queueFriendIDs.length === 0) {
          friendsList.forEach((friend) => {
            const id = friend.user.uri.split(":")[2];
            ActivityManager.queueFriendIDs.push(id);
          });
          ActivityManager.saveConfig();
        }
        
        if (!ActivityManager.playlistFriendIDs) {
          ActivityManager.playlistFriendIDs = [];
          ActivityManager.saveConfig();
        }
        
        setFriends(friendsList);
      };
      fetchFriends();
    }, []);
  
    if (friends.length === 0) {
      return createElement("div", null, "Friend list is loading...");
    }
  
    const allQueueSelected = friends.every((friend) =>
      ActivityManager.queueFriendIDs.includes(friend.user.uri.split(":")[2])
    );
    const allPlaylistSelected = friends.every((friend) =>
      ActivityManager.playlistFriendIDs.includes(friend.user.uri.split(":")[2])
    );

    const headerRow = createElement(
      "tr",
      null,
      createElement("th", { style: { padding: "10px", textAlign: "left" } }, "Users"),
      createElement("th", { style: { padding: "10px", textAlign: "center" } }, "Add to Queue"),
      createElement("th", { style: { padding: "10px", textAlign: "center" } }, "Add to Playlist")
    );
  
    const friendRows = friends.map((friend) => {
      const id = friend.user.uri.split(":")[2];
      const isQueueChecked = ActivityManager.queueFriendIDs.includes(id);
      const isPlaylistChecked = ActivityManager.playlistFriendIDs.includes(id);
  
      return createElement(
        "tr",
        { key: id },
        createElement(
          "td",
          {
            style: {
              padding: "10px",
              display: "flex",
              alignItems: "center",
            },
          },
          friend.user.imageUrl
            ? createElement("img", {
                src: friend.user.imageUrl,
                alt: friend.user.name,
                style: {
                  width: "30px",
                  height: "30px",
                  borderRadius: "50%",
                  marginRight: "8px",
                },
              })
            : null,
          createElement("span", null, friend.user.name)
        ),
        createElement(
          "td",
          { style: { textAlign: "center" } },
          createElement("input", {
            type: "checkbox",
            id: `queue-${id}`,
            checked: isQueueChecked,
            onChange: () => {
              ActivityManager.toggleQueueOption(id);
              forceUpdate((n) => !n);
            },
          })
        ),
        createElement(
          "td",
          { style: { textAlign: "center" } },
          createElement("input", {
            type: "checkbox",
            id: `playlist-${id}`,
            checked: isPlaylistChecked,
            onChange: () => {
              ActivityManager.togglePlaylistOption(id);
              forceUpdate((n) => !n);
            },
          })
        )
      );
    });
  
    const selectAllRow = createElement(
      "tr",
      null,
      createElement("td", { style: { fontWeight: "bold", padding: "10px" } }, "Select All"),
      createElement(
        "td",
        { style: { textAlign: "center" } },
        createElement("input", {
          type: "checkbox",
          id: "select-all-queue",
          checked: allQueueSelected,
          onChange: (event) => {
            const isChecked = event.target.checked;
            friends.forEach((friend) => {
              const id = friend.user.uri.split(":")[2];
              const already = ActivityManager.queueFriendIDs.includes(id);
              if (isChecked && !already) {
                ActivityManager.queueFriendIDs.push(id);
              } else if (!isChecked && already) {
                ActivityManager.queueFriendIDs = ActivityManager.queueFriendIDs.filter(
                  (existing) => existing !== id
                );
              }
            });
            ActivityManager.saveConfig();
            forceUpdate((n) => !n);
          },
        })
      ),
      createElement(
        "td",
        { style: { textAlign: "center" } },
        createElement("input", {
          type: "checkbox",
          id: "select-all-playlist",
          checked: allPlaylistSelected,
          onChange: (event) => {
            const isChecked = event.target.checked;
            friends.forEach((friend) => {
              const id = friend.user.uri.split(":")[2];
              const already = ActivityManager.playlistFriendIDs.includes(id);
              if (isChecked && !already) {
                ActivityManager.playlistFriendIDs.push(id);
              } else if (!isChecked && already) {
                ActivityManager.playlistFriendIDs = ActivityManager.playlistFriendIDs.filter(
                  (existing) => existing !== id
                );
              }
            });
            ActivityManager.saveConfig();
            forceUpdate((n) => !n);
          },
        })
      )
    );
  
    return createElement(
      "table",
      { style: { width: "100%", borderCollapse: "collapse" } },
      createElement("thead", null, headerRow),
      createElement("tbody", null, selectAllRow, friendRows)
    );
  }
  
  

  async function main() {
    ActivityManager.loadConfig();
    ActivityManager.insertSettingsControl();
    ActivityManager.beginTracking();
  }

  await main();
})();
