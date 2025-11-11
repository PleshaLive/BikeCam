const SECRET_KEYS = new Set(["credential", "password", "credentialtype", "credentialType", "username", "user", "key", "token"]);

export function getQueryFlag(name, def = 1) {
  const url = new URL(window.location.href);
  const value = url.searchParams.get(name);
  if (value === null) {
    return def === 1;
  }
  return value === "1" || value === "true";
}

export function maskSecret(value) {
  if (typeof value !== "string" || value.length <= 4) {
    return value ? "***" : "";
  }
  return `${"*".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}

export function scrubSecrets(data) {
  if (!data || typeof data !== "object") {
    return data;
  }
  if (Array.isArray(data)) {
    return data.map((item) => scrubSecrets(item));
  }
  const copy = {};
  for (const [key, value] of Object.entries(data)) {
    if (SECRET_KEYS.has(key)) {
      copy[key] = typeof value === "string" ? maskSecret(value) : value;
    } else if (value && typeof value === "object") {
      copy[key] = scrubSecrets(value);
    } else {
      copy[key] = value;
    }
  }
  return copy;
}

export function fingerprintIceServer(server) {
  if (!server) {
    return "";
  }
  const urls = Array.isArray(server.urls) ? server.urls.join(",") : server.urls;
  const parts = [];
  if (urls) {
    parts.push(urls);
  }
  if (server.username) {
    parts.push(`u:${maskSecret(server.username)}`);
  }
  if (server.credential) {
    parts.push(`c:${maskSecret(server.credential)}`);
  }
  return parts.join(" | ");
}

export function parseCandidate(candidate) {
  if (!candidate || typeof candidate !== "string") {
    return null;
  }
  const fields = candidate.trim().split(/\s+/);
  const result = {
    foundation: fields[0]?.split(":")[1] || "",
    component: fields[1] || "",
    protocol: fields[2] ? fields[2].toLowerCase() : "",
    priority: Number.parseInt(fields[3], 10) || 0,
    ip: fields[4] || "",
    port: fields[5] || "",
    type: "",
    relatedAddress: "",
    relatedPort: "",
    relayProtocol: "",
    raw: candidate,
  };

  for (let i = 6; i < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (!key) {
      continue;
    }
    switch (key) {
      case "typ":
        result.type = value || result.type;
        break;
      case "raddr":
        result.relatedAddress = value || result.relatedAddress;
        break;
      case "rport":
        result.relatedPort = value || result.relatedPort;
        break;
      case "tcptype":
        result.relayProtocol = value || result.relayProtocol;
        break;
      default:
        break;
    }
  }

  return result;
}

export function describeCandidate(candidateObj) {
  if (!candidateObj) {
    return "";
  }
  const parts = [candidateObj.type || "--", candidateObj.protocol || "--", candidateObj.ip && candidateObj.port ? `${candidateObj.ip}:${candidateObj.port}` : "--"];
  if (candidateObj.relayProtocol) {
    parts.push(`relay:${candidateObj.relayProtocol}`);
  }
  return parts.join(" | ");
}

export function scrubIceServersForUi(servers) {
  if (!Array.isArray(servers)) {
    return [];
  }
  return servers.map((entry) => {
    const copy = { ...entry };
    if (copy.credential) {
      copy.credential = maskSecret(copy.credential);
    }
    if (copy.username) {
      copy.username = maskSecret(copy.username);
    }
    return copy;
  });
}

export function valueOrDash(value) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  return value;
}
