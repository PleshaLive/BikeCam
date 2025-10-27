(() => {
  const TEAM_TITLES = {
    CT: "Команда CT",
    T: "Команда T",
  };

  const rawTeamKey = (window.TEAM_KEY || document.body.dataset.team || new URLSearchParams(window.location.search).get("team") || "").toUpperCase();
  const teamKey = rawTeamKey;
  const friendlyTitle = window.TEAM_TITLE || TEAM_TITLES[teamKey] || (teamKey ? `Team ${teamKey}` : "Команда");

  const titleElement = document.getElementById("teamLabel");
  const gridElement = document.getElementById("cameraGrid");
  const statusElement = document.getElementById("teamStatus");

  if (titleElement) {
    titleElement.textContent = friendlyTitle;
  }

  if (!teamKey) {
    if (statusElement) {
      statusElement.textContent = "Команда не указана. Добавьте ?team=CT или задайте TEAM_KEY.";
    }
    return;
  }

  const wsUrl = (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host;
  const MAX_PLAYERS = 5;
  const lastFrames = new Map();
  let slotElements = new Map();
  let currentPlayers = [];
  let currentPlayersKey = null;
  let ws;

  function fetchJson(url) {
    return fetch(url, { cache: "no-store" }).then((response) => {
      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }
      return response.json();
    });
  }

  function ensureStatus(message = "") {
    if (!statusElement) {
      return;
    }
    statusElement.textContent = message;
  }

  function buildPlayerCard(nickname) {
    const card = document.createElement("div");
    card.className = "slot no-feed";
    card.dataset.nickname = nickname;

    const frameWrapper = document.createElement("div");
    frameWrapper.className = "frame";

    const img = document.createElement("img");
    img.alt = nickname;

    const placeholder = document.createElement("div");
    placeholder.className = "placeholder";
    placeholder.textContent = "Нет камеры";

    const label = document.createElement("div");
    label.className = "nick";
    label.textContent = nickname;

    frameWrapper.appendChild(img);
    frameWrapper.appendChild(placeholder);
    card.appendChild(frameWrapper);
    card.appendChild(label);

    return { card, img, placeholder, label };
  }

  function buildEmptyCard() {
    const card = document.createElement("div");
    card.className = "slot placeholder-only";

    const frameWrapper = document.createElement("div");
    frameWrapper.className = "frame";

    const label = document.createElement("div");
    label.className = "nick";
    label.textContent = "—";

    const placeholder = document.createElement("div");
    placeholder.className = "placeholder";
    placeholder.textContent = "Ожидаем игрока";

    frameWrapper.appendChild(placeholder);
    card.appendChild(frameWrapper);
    card.appendChild(label);

    return card;
  }

  function renderPlayers(names) {
    const limited = names.slice(0, MAX_PLAYERS);
    const key = limited.join("|");
    if (key === currentPlayersKey && limited.length === currentPlayers.length) {
      return;
    }

    currentPlayersKey = key;
    currentPlayers = limited;

    const fragment = document.createDocumentFragment();
    const newSlotElements = new Map();

    for (const nickname of limited) {
      const slot = buildPlayerCard(nickname);
      fragment.appendChild(slot.card);
      newSlotElements.set(nickname, slot);

      const cached = lastFrames.get(nickname);
      if (cached?.frame) {
        slot.img.src = cached.frame;
        slot.card.classList.remove("no-feed");
      } else {
        slot.card.classList.add("no-feed");
        slot.img.removeAttribute("src");
      }
    }

    for (let i = limited.length; i < MAX_PLAYERS; i += 1) {
      fragment.appendChild(buildEmptyCard());
    }

    gridElement.innerHTML = "";
    gridElement.appendChild(fragment);
    slotElements = newSlotElements;
  }

  function updatePlayerFrame(nickname, frame, updatedAt) {
    if (!nickname) {
      return;
    }

    if (frame) {
      lastFrames.set(nickname, { frame, updatedAt: updatedAt || Date.now() });
    } else {
      lastFrames.delete(nickname);
    }

    const slot = slotElements.get(nickname);
    if (!slot) {
      if (!currentPlayers.includes(nickname) && currentPlayers.length < MAX_PLAYERS) {
        const updatedList = [...currentPlayers, nickname];
        renderPlayers(updatedList);
        return updatePlayerFrame(nickname, frame, updatedAt);
      }
      return;
    }

    if (frame) {
      slot.img.src = frame;
      slot.card.classList.remove("no-feed");
    } else {
      slot.img.removeAttribute("src");
      slot.card.classList.add("no-feed");
    }
  }

  function handleWelcome(data) {
    if (Array.isArray(data.cameras)) {
      for (const snapshot of data.cameras) {
        if (!snapshot || typeof snapshot.nickname !== "string") {
          continue;
        }
        const snapshotTeam = typeof snapshot.team === "string" ? snapshot.team.toUpperCase() : null;
        if (snapshotTeam && snapshotTeam !== teamKey) {
          continue;
        }
        lastFrames.set(snapshot.nickname, {
          frame: snapshot.frame,
          updatedAt: snapshot.updatedAt,
        });
        updatePlayerFrame(snapshot.nickname, snapshot.frame, snapshot.updatedAt);
      }
    }
  }

  function handlePlayerFrame(data) {
    if (!data || typeof data.nickname !== "string") {
      return;
    }
    const dataTeam = typeof data.team === "string" ? data.team.toUpperCase() : null;
    if (dataTeam && dataTeam !== teamKey) {
      return;
    }
    if (!dataTeam && !currentPlayers.includes(data.nickname)) {
      return;
    }
    updatePlayerFrame(data.nickname, data.frame, data.updatedAt);
  }

  function handleStateUpdate() {
    fetchTeams();
  }

  function connectWebSocket() {
    ws = new WebSocket(wsUrl);

    ws.addEventListener("open", () => {
      ensureStatus("");
    });

    ws.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (error) {
        return;
      }

      switch (payload.type) {
        case "WELCOME":
          handleWelcome(payload);
          break;
        case "STATE_UPDATE":
          handleStateUpdate();
          break;
        case "PLAYER_FRAME":
          handlePlayerFrame(payload);
          break;
        case "FOCUS_FRAME":
          if (payload.nickname && currentPlayers.includes(payload.nickname)) {
            updatePlayerFrame(payload.nickname, payload.frame, payload.updatedAt);
          }
          break;
        default:
          break;
      }
    });

    ws.addEventListener("close", () => {
      ensureStatus("WebSocket отключён. Переподключаемся…");
      setTimeout(connectWebSocket, 2000);
    });

    ws.addEventListener("error", () => {
      ws.close();
    });
  }

  async function fetchTeams() {
    try {
      const data = await fetchJson("/teams");
      const teamPlayers = data?.teams?.[teamKey] || [];
      renderPlayers(teamPlayers);
      ensureStatus(teamPlayers.length ? "" : "Состав команды пока не определён.");
    } catch (error) {
      ensureStatus("Не удалось получить состав команды.");
    }
  }

  async function fetchCameraSnapshot(nickname) {
    if (!nickname) {
      return;
    }
    try {
      const data = await fetchJson(`/camera/${encodeURIComponent(nickname)}`);
      updatePlayerFrame(data.nickname || nickname, data.frame, data.updatedAt);
    } catch (error) {
      updatePlayerFrame(nickname, null, Date.now());
    }
  }

  setInterval(() => {
    for (const nickname of currentPlayers) {
      const cached = lastFrames.get(nickname);
      const age = cached ? Date.now() - (cached.updatedAt || 0) : Infinity;
      if (age > 2000) {
        fetchCameraSnapshot(nickname);
      }
    }
  }, 2000);

  setInterval(fetchTeams, 5000);

  fetchTeams();
  connectWebSocket();
})();
