(async function () {
  // Spicetify bileşenlerinin yüklenmesini bekle
  while (
    !Spicetify ||
    !Spicetify.React ||
    !Spicetify.ReactDOM ||
    !Spicetify.Platform ||
    !Spicetify.Topbar
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // React hook'larını al
  const { createElement, useState, useEffect } = Spicetify.React;

  class ActivityManager {
    // Arkadaşların ID'lerini ve çalma listelerini saklamak için
    static queueFriendIDs = [];
    static playlistFriendIDs = [];
    static friendPlaylists = {};
    static lastTrackStates = {}; // Her arkadaşın son dinlediği şarkıyı saklar
    static playlistCache = new Map(); // Çalma listelerini önbelleğe alır
    static friendListCache = []; // Arkadaş listesini önbelleğe alır

    // Ayarları LocalStorage'dan yükle
    static loadConfig() {
      this.queueFriendIDs = JSON.parse(Spicetify.LocalStorage.get("queueFriendIDs") || "[]");
      this.playlistFriendIDs = JSON.parse(Spicetify.LocalStorage.get("playlistFriendIDs") || "[]");
    }

    // Ayarları LocalStorage'a kaydet
    static saveConfig() {
      Spicetify.LocalStorage.set("queueFriendIDs", JSON.stringify(this.queueFriendIDs));
      Spicetify.LocalStorage.set("playlistFriendIDs", JSON.stringify(this.playlistFriendIDs));
    }

    // Takip işlemini başlat
    static async beginTracking() {
      await this.initializeDependencies(); // Gerekli API'lerin yüklenmesini bekle
      await this.refreshFriendList(); // Arkadaş listesini güncelle
      this.startPeriodicCheck(); // 120 saniyede bir kontrol et
    }

    // Gerekli API'lerin yüklenmesini bekle
    static async initializeDependencies() {
      while (!Spicetify.Platform.BuddyFeedAPI || !Spicetify.CosmosAsync) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }

    // Arkadaş listesini güncelle
    static async refreshFriendList() {
      this.friendListCache = await this.fetchFriendList(); // Arkadaş listesini çek
      this.friendListCache.forEach(friend => {
        const friendID = this.extractFriendID(friend);
        if (!this.queueFriendIDs.includes(friendID)) {
          this.queueFriendIDs.push(friendID); // Yeni arkadaşları otomatik ekle
        }
      });
      this.saveConfig(); // Ayarları kaydet
    }

    // Arkadaş listesini API'den çek
    static async fetchFriendList() {
      const { friends } = await Spicetify.CosmosAsync.get(
        "https://spclient.wg.spotify.com/presence-view/v1/buddylist"
      );
      return friends.reverse(); // En yeni etkinlikler üstte olacak şekilde sırala
    }

    // 120 saniyede bir arkadaş aktivitelerini kontrol et
    static startPeriodicCheck() {
      setInterval(async () => {
        try {
          const activities = await Spicetify.CosmosAsync.get(
            "https://spclient.wg.spotify.com/presence-view/v1/buddylist"
          );
          this.processActivities(activities.friends); // Etkinlikleri işle
        } catch (error) {
          console.error('Periodik kontrol başarısız:', error);
        }
      }, 120000); // 120 saniye (2 dakika)
    }

    // Etkinlikleri işle
    static processActivities(friends) {
      friends.forEach(friend => {
        const friendID = this.extractFriendID(friend);
        const currentTrack = friend.track?.uri;
        
        // Yeni şarkı dinlenmişse işle
        if (currentTrack && this.lastTrackStates[friendID] !== currentTrack) {
          this.handleTrackChange(friend, friendID, currentTrack);
        }
      });
    }

    // Yeni şarkı dinlendiğinde yapılacak işlemler
    static handleTrackChange(friend, friendID, currentTrack) {
      const event = {
        track: { uri: currentTrack },
        user: friend.user
      };

      this.processQueueAddition(event, friendID); // Kuyruğa ekle
      this.processPlaylistAddition(event, friendID); // Çalma listesine ekle
      this.lastTrackStates[friendID] = currentTrack; // Son şarkıyı kaydet
    }

    // Kuyruğa şarkı ekle
    static processQueueAddition(event, friendID) {
      if (this.queueFriendIDs.includes(friendID)) {
        Spicetify.Platform.PlayerAPI.addToQueue([{
          uri: event.track.uri,
          uid: null
        }]).catch(() => {}); // Hata olursa görmezden gel
      }
    }

    // Çalma listesine şarkı ekle
    static async processPlaylistAddition(event, friendID) {
      if (!this.playlistFriendIDs.includes(friendID)) return; // Ayarlanmamışsa atla

      try {
        const [playlistUri, exists] = await Promise.all([
          this.obtainPlaylistForFriend(friendID, event.user.name), // Çalma listesini al
          this.checkTrackInPlaylistQuick(event.track.uri) // Şarkı listede var mı kontrol et
        ]);

        if (!exists) {
          await Spicetify.CosmosAsync.post(
            `https://api.spotify.com/v1/playlists/${playlistUri.split(":")[2]}/tracks`,
            { uris: [event.track.uri] }
          );
          Spicetify.showNotification(`Çalma listesine eklendi: ${event.track.name}`);
        }
      } catch (error) {}
    }

    // Arkadaş için çalma listesi oluştur veya bul
    static async obtainPlaylistForFriend(friendID, friendName) {
      if (this.friendPlaylists[friendID]) {
        return this.friendPlaylists[friendID]; // Önbellekte varsa direkt dön
      }

      const playlistName = `FriendID: ${friendID}`;
      const cachedPlaylist = this.playlistCache.get(playlistName);
      if (cachedPlaylist) return cachedPlaylist; // Önbellekte varsa kullan

      const playlist = await this.findOrCreatePlaylist(playlistName, friendName);
      this.friendPlaylists[friendID] = playlist.uri;
      this.playlistCache.set(playlistName, playlist.uri);
      
      return playlist.uri;
    }

    // Çalma listesini bul veya oluştur
    static async findOrCreatePlaylist(name, description) {
      let playlists = [];
      let nextUrl = "https://api.spotify.com/v1/me/playlists?limit=50";
      
      while (nextUrl) {
        const response = await Spicetify.CosmosAsync.get(nextUrl);
        playlists = playlists.concat(response.items);
        nextUrl = response.next;
      }

      let playlist = playlists.find(pl => pl.name === name);
      if (!playlist) {
        playlist = await Spicetify.CosmosAsync.post(
          "https://api.spotify.com/v1/me/playlists",
          { name, description: `${description} tarafından dinlenen şarkılar`, public: false }
        );
        await Spicetify.CosmosAsync.put(
          `https://api.spotify.com/v1/playlists/${playlist.id}`,
          { public: false }
        );
      }
      return playlist;
    }

    // Şarkının çalma listesinde olup olmadığını hızlıca kontrol et
    static async checkTrackInPlaylistQuick(trackUri) {
      try {
        const response = await Spicetify.CosmosAsync.get(
          `https://api.spotify.com/v1/me/tracks/contains?ids=${trackUri.split(":")[2]}`
        );
        return response[0];
      } catch (error) {
        return false;
      }
    }

    // Arkadaş ID'sini çıkar
    static extractFriendID(friend) {
      return friend.user.uri.split(":")[2];
    }

    // Ayarlar panelini Spotify arayüzüne ekle
    static async insertSettingsControl() {
      while (!Spicetify.Topbar || !Spicetify.React || !Spicetify.PopupModal) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

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

  // Ayarlar paneli React bileşeni
  function SettingsPanel() {
    const [friends, setFriends] = useState([]);
    const [, forceUpdate] = useState(0);
  
    useEffect(() => {
      const fetchFriends = async () => {
        const friendsList = await ActivityManager.fetchFriendList();
        
        if (ActivityManager.queueFriendIDs.length === 0) {
          friendsList.forEach((friend) => {
            const id = ActivityManager.extractFriendID(friend);
            ActivityManager.queueFriendIDs.push(id);
          });
          ActivityManager.saveConfig();
        }
        
        setFriends(friendsList);
      };
      fetchFriends();
    }, []);
  
    if (friends.length === 0) {
      return createElement("div", null, "Arkadaş listesi yükleniyor...");
    }
  
    const allQueueSelected = friends.every((friend) =>
      ActivityManager.queueFriendIDs.includes(ActivityManager.extractFriendID(friend))
    );
    const allPlaylistSelected = friends.every((friend) =>
      ActivityManager.playlistFriendIDs.includes(ActivityManager.extractFriendID(friend))
    );

    const headerRow = createElement(
      "tr",
      null,
      createElement("th", { style: { padding: "10px", textAlign: "left" } }, "Kullanıcılar"),
      createElement("th", { style: { padding: "10px", textAlign: "center" } }, "Kuyruğa Ekle"),
      createElement("th", { style: { padding: "10px", textAlign: "center" } }, "Çalma Listesine Ekle")
    );
  
    const friendRows = friends.map((friend) => {
      const id = ActivityManager.extractFriendID(friend);
      const isQueueChecked = ActivityManager.queueFriendIDs.includes(id);
      const isPlaylistChecked = ActivityManager.playlistFriendIDs.includes(id);
  
      return createElement(
        "tr",
        { key: id },
        createElement(
          "td",
          { style: { padding: "10px", display: "flex", alignItems: "center" } },
          friend.user.imageUrl && createElement("img", {
            src: friend.user.imageUrl,
            alt: friend.user.name,
            style: { width: "30px", height: "30px", borderRadius: "50%", marginRight: "8px" },
          }),
          createElement("span", null, friend.user.name)
        ),
        createElement(
          "td",
          { style: { textAlign: "center" } },
          createElement("input", {
            type: "checkbox",
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
      createElement("td", { style: { fontWeight: "bold", padding: "10px" } }, "Tümünü Seç"),
      createElement(
        "td",
        { style: { textAlign: "center" } },
        createElement("input", {
          type: "checkbox",
          checked: allQueueSelected,
          onChange: (event) => {
            const isChecked = event.target.checked;
            friends.forEach((friend) => {
              const id = ActivityManager.extractFriendID(friend);
              const already = ActivityManager.queueFriendIDs.includes(id);
              if (isChecked && !already) ActivityManager.queueFriendIDs.push(id);
              else if (!isChecked && already) ActivityManager.queueFriendIDs = ActivityManager.queueFriendIDs.filter((existing) => existing !== id);
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
          checked: allPlaylistSelected,
          onChange: (event) => {
            const isChecked = event.target.checked;
            friends.forEach((friend) => {
              const id = ActivityManager.extractFriendID(friend);
              const already = ActivityManager.playlistFriendIDs.includes(id);
              if (isChecked && !already) ActivityManager.playlistFriendIDs.push(id);
              else if (!isChecked && already) ActivityManager.playlistFriendIDs = ActivityManager.playlistFriendIDs.filter((existing) => existing !== id);
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

  // Uygulamayı başlat
  async function main() {
    ActivityManager.loadConfig();
    ActivityManager.insertSettingsControl();
    ActivityManager.beginTracking();
  }

  await main();
})();