"use strict";

const WALLET_SESSION_KEY = "orbitchain.walletSession";
const VALID_SOURCES = new Set(["freighter", "manual"]);

function isValidPublicKey(value) {
  return typeof value === "string" && /^G[A-Z2-7]{55}$/.test(value);
}

function discardStoredSession(storage) {
  try {
    storage?.removeItem(WALLET_SESSION_KEY);
  } catch (_error) {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function readSession(storage) {
  if (!storage) return null;

  let rawSession;
  try {
    rawSession = storage.getItem(WALLET_SESSION_KEY);
  } catch (_error) {
    return null;
  }

  if (rawSession === null) return null;

  try {
    const session = JSON.parse(rawSession);
    if (
      session &&
      isValidPublicKey(session.publicKey) &&
      VALID_SOURCES.has(session.source)
    ) {
      return {
        publicKey: session.publicKey,
        source: session.source,
      };
    }
  } catch (_error) {
    // Invalid JSON is treated like any other invalid persisted session.
  }

  discardStoredSession(storage);
  return null;
}

function writeSession(storage, publicKey, source) {
  if (!storage) return false;

  try {
    storage.setItem(
      WALLET_SESSION_KEY,
      JSON.stringify({ publicKey, source }),
    );
    return true;
  } catch (_error) {
    return false;
  }
}

function clearSession(storage) {
  if (!storage) return false;

  try {
    storage.removeItem(WALLET_SESSION_KEY);
    return true;
  } catch (_error) {
    return false;
  }
}

function errorMessage(error, fallback) {
  if (typeof error === "string" && error) return error;
  if (error && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return fallback;
}

function throwResponseError(response) {
  if (response && typeof response === "object" && response.error) {
    throw new Error(errorMessage(response.error, "Freighter request failed."));
  }
}

function extractAddress(response) {
  throwResponseError(response);

  const address =
    typeof response === "string" ? response : response?.address;
  if (!isValidPublicKey(address)) {
    throw new Error("Freighter did not return a valid public key.");
  }

  return address;
}

function connectedFromResponse(response) {
  throwResponseError(response);
  if (typeof response === "boolean") return response;
  return response?.isConnected === true;
}

async function requestFreighterAddress(provider) {
  if (typeof provider.requestAccess === "function") {
    return extractAddress(await provider.requestAccess());
  }

  if (typeof provider.isConnected === "function") {
    const connected = connectedFromResponse(await provider.isConnected());
    if (!connected) {
      if (typeof provider.connect !== "function") {
        throw new Error("Freighter access is not available.");
      }
      await provider.connect();
    }
  }

  if (typeof provider.getAddress !== "function") {
    throw new Error("Freighter does not expose a public-key API.");
  }

  return extractAddress(await provider.getAddress());
}

async function restoreFreighterAddress(provider) {
  if (!provider || typeof provider.getAddress !== "function") {
    throw new Error("Freighter is not available.");
  }

  if (typeof provider.isConnected === "function") {
    const connected = connectedFromResponse(await provider.isConnected());
    if (!connected) throw new Error("Freighter is not connected.");
  }

  return extractAddress(await provider.getAddress());
}

function createWalletSession({
  storage,
  provider = null,
  promptForAddress = () => null,
  ui,
  emit = () => {},
}) {
  let connected = false;

  async function initialize() {
    const savedSession = readSession(storage);
    if (!savedSession) {
      ui.showDisconnected({ reconnect: false, statusText: "" });
      return null;
    }

    ui.showReconnecting();

    if (savedSession.source === "manual") {
      ui.showDisconnected({
        reconnect: true,
        statusText: "Previous wallet found. Reconnect to continue.",
      });
      return null;
    }

    try {
      const publicKey = await restoreFreighterAddress(provider);
      const persisted = writeSession(storage, publicKey, "freighter");
      connected = true;
      ui.showConnected(
        publicKey,
        persisted
          ? ""
          : "Wallet reconnected, but this session could not be saved.",
      );
      emit("wallet:reconnected", { publicKey, source: "freighter" });
      return publicKey;
    } catch (_error) {
      connected = false;
      ui.showDisconnected({
        reconnect: true,
        statusText: "Unable to restore wallet. Reconnect to continue.",
      });
      return null;
    }
  }

  async function connect() {
    ui.showConnecting();

    try {
      const source = provider ? "freighter" : "manual";
      let publicKey;

      if (provider) {
        publicKey = await requestFreighterAddress(provider);
      } else {
        const promptedAddress = await promptForAddress();
        if (!isValidPublicKey(promptedAddress)) {
          throw new Error("Invalid or cancelled address input.");
        }
        publicKey = promptedAddress;
      }

      const persisted = writeSession(storage, publicKey, source);
      connected = true;
      ui.showConnected(
        publicKey,
        persisted
          ? ""
          : "Wallet connected, but this session could not be saved.",
      );
      emit("wallet:connected", { publicKey, source });
      return publicKey;
    } catch (error) {
      connected = false;
      ui.showDisconnected({
        reconnect: readSession(storage) !== null,
        statusText: `❌ ${errorMessage(error, "Unable to connect wallet.")}`,
      });
      return null;
    }
  }

  function disconnect() {
    connected = false;
    const cleared = clearSession(storage);
    ui.showDisconnected({
      reconnect: false,
      statusText: cleared
        ? "Disconnected."
        : "Disconnected, but the saved session could not be cleared.",
    });
    emit("wallet:disconnected", {});
  }

  async function handleAction() {
    if (connected) {
      disconnect();
      return undefined;
    }
    return connect();
  }

  return {
    initialize,
    connect,
    disconnect,
    handleAction,
  };
}

function createDomUi(document) {
  const button = document.getElementById("connect-btn");
  const walletInfo = document.getElementById("wallet-info");
  const walletAddress = document.getElementById("wallet-address");
  const status = document.getElementById("status");

  if (!button || !walletInfo || !walletAddress || !status) {
    throw new Error("Wallet connect markup is incomplete.");
  }

  function hideWalletInfo() {
    walletInfo.style.display = "none";
    walletAddress.textContent = "";
  }

  return {
    showConnecting() {
      hideWalletInfo();
      button.textContent = "Connecting…";
      button.disabled = true;
      status.textContent = "Connecting…";
    },
    showReconnecting() {
      hideWalletInfo();
      button.textContent = "Reconnecting…";
      button.disabled = true;
      status.textContent = "Reconnecting wallet…";
    },
    showConnected(publicKey, statusText) {
      walletAddress.textContent = publicKey;
      walletInfo.style.display = "block";
      button.textContent = "Disconnect";
      button.disabled = false;
      status.textContent = statusText;
    },
    showDisconnected({ reconnect, statusText }) {
      hideWalletInfo();
      button.textContent = reconnect ? "Reconnect Wallet" : "Connect Wallet";
      button.disabled = false;
      status.textContent = statusText;
    },
    onAction(handler) {
      button.addEventListener("click", handler);
    },
  };
}

async function initializeWalletPage(browserWindow) {
  const provider =
    browserWindow.freighterApi || browserWindow.freighter || null;
  let storage = null;
  try {
    storage = browserWindow.localStorage;
  } catch (_error) {
    // The controller can still operate for the current page without storage.
  }

  const ui = createDomUi(browserWindow.document);
  const controller = createWalletSession({
    storage,
    provider,
    promptForAddress: () =>
      browserWindow.prompt(
        "Freighter not detected.\nEnter your Stellar public key to continue:",
      ),
    ui,
    emit: (name, detail) =>
      browserWindow.dispatchEvent(
        new browserWindow.CustomEvent(name, { detail }),
      ),
  });

  ui.onAction(() => controller.handleAction());
  browserWindow.connectWallet = controller.connect;
  browserWindow.disconnectWallet = controller.disconnect;

  await controller.initialize();
  return controller;
}

const walletSessionApi = {
  WALLET_SESSION_KEY,
  createDomUi,
  createWalletSession,
  initializeWalletPage,
  isValidPublicKey,
  readSession,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = walletSessionApi;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.OrbitChainWalletSession = walletSessionApi;
  void initializeWalletPage(window);
}
