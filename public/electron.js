const { app, BrowserWindow, screen, ipcMain, Menu } = require("electron");
const http = require("http");
const path = require("path");
const { readdirSync, existsSync } = require("fs");
const Store = require("electron-store");
const store = new Store();
const isDev = !app.isPackaged;
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";

let mainWindow;
let tinyWindow;
let settingsWindow;
let server;
let serverState = {};
let autoHide = store.get("autoHide", false);
let shouldQuit = false;
let handleWindowBoundsTimer;

const initialSquareSize = 100;
const minSquareSize = 50;
var maxScreenWidth;
var maxScreenHeight;

const gotTheLock = app.requestSingleInstanceLock();

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getClampedRect(rect, bounds) {
  var rectLeft = rect.x;
  var rectRight = rect.x + rect.width;
  var rectTop = rect.y;
  var rectBottom = rect.y + rect.height;

  const boundsLeft = bounds.x;
  const boundsRight = bounds.x + bounds.width;
  const boundsTop = bounds.y;
  const boundsBottom = bounds.y + bounds.height;

  const leftDifference = rectLeft - boundsLeft; // should be >= 0
  const rightDifference = boundsRight - rectRight; // should be >= 0
  const topDifference = rectTop - boundsTop; // should be >= 0
  const bottomDifference = boundsBottom - rectBottom; // should be >= 0

  // Move back to be contained in bounds
  if (leftDifference < 0) {
    rectLeft = boundsLeft;
    rectRight -= leftDifference;
  }

  if (rightDifference < 0) {
    rectRight = boundsRight;
    rectLeft += rightDifference;
  }

  if (topDifference < 0) {
    rectTop = boundsTop;
    rectBottom -= topDifference;
  }

  if (bottomDifference < 0) {
    rectBottom = boundsBottom;
    rectTop += bottomDifference;
  }

  // Clamp to bounds if bigger
  if (rectLeft < boundsLeft) {
    rectLeft = boundsLeft;
  }

  if (rectRight > boundsRight) {
    rectRight = boundsRight;
  }

  if (rectTop < rectTop) {
    rectTop = rectTop;
  }

  if (rectBottom > boundsBottom) {
    rectBottom = boundsBottom;
  }

  const newBounds = {
    x: rectLeft,
    y: rectTop,
    width: rectRight - rectLeft,
    height: rectBottom - rectTop,
  };

  return newBounds;
}

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance, we should show and focus our window.
    if (mainWindow) {
      mainWindow.show();
    }
  });

  function hideIfAutoHide() {
    if (autoHide && !BrowserWindow.getFocusedWindow()) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
      }
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.hide();
      }
      if (isWin && tinyWindow && !tinyWindow.isDestroyed()) {
        tinyWindow.showInactive();
      }
    }
  }

  function showIfAutoHide() {
    if (autoHide) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.showInactive();
      }
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.showInactive();
      }
      if (isWin && tinyWindow && !tinyWindow.isDestroyed()) {
        tinyWindow.hide();
      }
    }
  }

  function isFullyContainedInDisplay(winBounds, win, clamp) {
    if (!winBounds) {
      winBounds = win.getBounds();
    }

    const currentDisplay = screen.getDisplayMatching(winBounds);
    const displayBounds = currentDisplay.bounds;
    const newBounds = getClampedRect(winBounds, displayBounds);

    const fullyContained =
      newBounds.width === winBounds.width &&
      newBounds.height === winBounds.height &&
      newBounds.x === winBounds.x &&
      newBounds.y === winBounds.y;
    if (fullyContained) {
      return winBounds;
    } else if (clamp) {
      win.setBounds(newBounds);
      return newBounds;
    } else {
      return false;
    }
  }

  function handleWindowBounds() {
    const bounds = mainWindow.getBounds();
    clearTimeout(handleWindowBoundsTimer);
    mainWindow.webContents.send("windowBounds", bounds);

    handleWindowBoundsTimer = setTimeout(function () {
      const boundsToStore = isFullyContainedInDisplay(bounds, mainWindow, true);
      if (boundsToStore) {
        store.set("x", bounds.x);
        store.set("y", bounds.y);
        store.set("width", bounds.width);
        store.set("height", bounds.height);
      }
    }, 400);
  }

  function startServer(event, data) {
    const sockets = [];

    server = http.createServer((request, response) => {
      // Keep all the response objects in memory,
      // and start listening for data on the render process.
      // Write to the response as soon as we receive data
      // from the render process and close it.
      ipcMain.once("data", (event, data) => {
        response.writeHead(200, {
          "Content-Type": "text/plain",
          "Access-Control-Allow-Origin": "*",
        });

        // return response
        response.write(JSON.stringify(data), "utf8");
        response.end();
      });
    });

    server.on("connection", function (socket) {
      sockets.push(socket);
    });

    server.on("error", (e) => {
      var message;
      if (e.code === "EADDRINUSE") {
        message = `Port ${data.port} is already in use. Choose a different port.`;
      } else {
        message = JSON.stringify(e);
      }

      serverState = { error: true, message: message };
      mainWindow.webContents.send("serverState", serverState);
    });

    server.on("close", (e) => {
      serverState = { error: false, message: "Server closed." };
      mainWindow.webContents.send("serverState", serverState);
    });

    server.on("listening", (e) => {
      serverState = {
        error: false,
        message: `Server is listening on http://localhost:${data.port}.`,
      };
      mainWindow.webContents.send("serverState", serverState);
    });

    server.listen(data.port);

    const stopServer = function () {
      server.close();
      while (sockets.length) {
        sockets.pop().destroy();
      }
      ipcMain.once("start-server", startServer);
    };

    ipcMain.once("stop-server", stopServer);
  }

  // Create myWindow, load the rest of the app, etc...
  ipcMain.once("start-server", startServer);

  function setMaxScreenDimension() {
    let newMaxScreenWidth = 0,
      newMaxScreenHeight = 0;
    const displays = screen.getAllDisplays();
    displays.forEach(function (display) {
      if (display.size.width > newMaxScreenWidth) {
        newMaxScreenWidth = display.size.width;
      }
      if (display.size.height > newMaxScreenHeight) {
        newMaxScreenHeight = display.size.height;
      }
    });
    maxScreenWidth = newMaxScreenWidth;
    maxScreenHeight = newMaxScreenHeight;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setMaximumSize(maxScreenWidth, maxScreenHeight);
    }
  }

  function init() {
    const template = [
      // { role: 'appMenu' }
      ...(isMac
        ? [
            {
              label: app.name,
              submenu: [
                { role: "about" },
                { type: "separator" },
                { role: "services" },
                { type: "separator" },
                { role: "hide" },
                { role: "hideothers" },
                { role: "unhide" },
                { type: "separator" },
                { role: "quit" },
              ],
            },
          ]
        : []),
      {
        label: "File",
        submenu: [isMac ? { role: "close" } : { role: "quit" }],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forcereload" },
          { type: "separator" },
          { role: "toggledevtools" },
        ],
      },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [
          {
            label: "Learn More",
            click: async () => {
              const { shell } = require("electron");
              await shell.openExternal(
                "https://github.com/Jip-Hop/Screen-Breach-Sensor"
              );
            },
          },
        ],
      },
      ...(isMac
        ? [
            {
              label: "hidden",
              visible: false,
              submenu: [
                {
                  label: "Cycle windows",
                  type: "checkbox",
                  accelerator: "Command+`",
                  click: () => {
                    const focusedWindow = BrowserWindow.getFocusedWindow();
                    if (
                      focusedWindow &&
                      mainWindow &&
                      !mainWindow.isDestroyed() &&
                      settingsWindow &&
                      !settingsWindow.isDestroyed()
                    ) {
                      if (focusedWindow == mainWindow) {
                        settingsWindow.moveTop();
                        settingsWindow.show();
                      } else {
                        mainWindow.moveTop();
                        mainWindow.show();
                      }
                    }
                  },
                },
              ],
            },
          ]
        : []),
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);

    if (isDev) {
      // Load "React Developer Tools" extension if installed with Google Chrome
      const appDataPath = app.getPath("appData");
      const extensionsPath = isMac
        ? path.join(
            appDataPath,
            "Google/Chrome/Default/Extensions/fmkadmapgofadopljbjfkapdkoienihi"
          )
        : isWin
        ? path.join(
            appDataPath,
            "../",
            "Local",
            "Google",
            "Chrome",
            "User Data",
            "Default",
            "Extensions",
            "fmkadmapgofadopljbjfkapdkoienihi"
          )
        : null;

      if (existsSync(extensionsPath)) {
        readdirSync(extensionsPath, { withFileTypes: true })
          .filter((dirent) => dirent.isDirectory())
          .map((dirent) => dirent.name)
          .forEach((folderName) => {
            BrowserWindow.addDevToolsExtension(
              path.join(extensionsPath, folderName)
            );
          });
      }
    }

    setMaxScreenDimension();
    createWindow();
    screen.on("display-metrics-changed", setMaxScreenDimension);
  }

  function createWindow() {
    if (isMac) {
      app.dock.hide();
    }

    mainWindow = new BrowserWindow({
      x: store.get("x", null),
      y: store.get("y", null),
      width: store.get("width", initialSquareSize),
      height: store.get("height", initialSquareSize),
      minWidth: minSquareSize,
      minHeight: minSquareSize,
      maxWidth: maxScreenWidth,
      maxHeight: maxScreenHeight,
      titleBarStyle: isMac ? "customButtonsOnHover" : undefined,
      frame: false,
      transparent: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      resizable: true,
      enableLargerThanScreen: true,
      webPreferences: { nodeIntegration: true, nativeWindowOpen: true },
      backgroundColor: "#00ffffff",
    });

    mainWindow.on("minimize", () => {
      mainWindow.restore();
    });

    mainWindow.setAlwaysOnTop(true, "pop-up-menu");

    mainWindow.webContents.on(
      "new-window",
      (event, url, frameName, disposition, options) => {
        // open window as modal
        event.preventDefault();
        const mainWindowBounds = mainWindow.getBounds();
        const currentScreen = screen.getDisplayMatching(mainWindowBounds);
        const currentScreenSize = currentScreen.size;
        Object.assign(options, {
          width: currentScreenSize.width / 2,
          height: currentScreen.workArea.height,
          x:
            mainWindowBounds.x -
              currentScreen.bounds.x +
              mainWindowBounds.width / 2 >
            currentScreenSize.width / 2
              ? currentScreen.bounds.x
              : currentScreen.bounds.x + currentScreenSize.width / 2,
          y: currentScreen.workArea.y,
          frame: !isMac, // no frame on MacOS, so it can be shown on top of most full screen apps
          titleBarStyle: isMac ? "hidden" : undefined,
          transparent: false,
          movable: true,
          minimizable: false,
          maximizable: true,
          fullscreenable: false,
          resizable: true,
          backgroundColor: "#ffffff",
          hasShadow: true,
          minWidth: 295,
          title: `${app.name} Settings`,
        });

        if (isMac) {
          app.dock.hide();
        }
        settingsWindow = event.newGuest = new BrowserWindow(options);

        settingsWindow.on("minimize", () => {
          settingsWindow.restore();
        });

        settingsWindow.on("closed", () => {
          settingsWindow = null;
        });

        settingsWindow.setAlwaysOnTop(true, "pop-up-menu");

        if (isMac) {
          settingsWindow.setVisibleOnAllWorkspaces(true, {
            visibleOnFullScreen: true,
          });
          app.dock.show();
        }
      }
    );

    mainWindow.on("move", handleWindowBounds);
    mainWindow.on("resize", handleWindowBounds);

    mainWindow.webContents.on(
      "select-bluetooth-device",
      (event, deviceList, callback) => {
        event.preventDefault();

        let pairedId = store.get("pairedId", false);

        let result = deviceList.find((device) => {
          // Connect to device with pairedId, or pair with first device found
          return pairedId ? device.deviceId === pairedId : true;
        });
        if (!result) {
          callback("");
        } else {
          store.set("pairedId", result.deviceId);
          callback(result.deviceId);
        }
      }
    );

    mainWindow.webContents.on("did-start-loading", () => {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.close();
      }
    });

    // Use tinyWindow to catch focus events,
    // when the other windows are hidden
    tinyWindow = new BrowserWindow({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      frame: false,
      transparent: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      resizable: false,
      closable: false,
      backgroundColor: "#00ffffff",
      show: isMac,
    });

    tinyWindow.on("minimize", () => {
      tinyWindow.restore();
    });

    tinyWindow.on("close", (event) => {
      if (mainWindow) {
        event.preventDefault();
      }
    });

    tinyWindow.on("focus", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
      }
    });

    tinyWindow.on("closed", () => {
      tinyWindow = null;
    });

    if (isMac) {
      tinyWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

      app.dock.show();
    }

    mainWindow.loadURL(
      isDev
        ? "http://localhost:3000"
        : `file://${path.join(__dirname, "../build/index.html")}`
    );

    // if (isDev) {
    //   // Open the DevTools.
    //   mainWindow.webContents.openDevTools();
    // }

    mainWindow.on("focus", () => {
      mainWindow.moveTop();
    });

    mainWindow.on("closed", () => {
      mainWindow = null;
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.close();
      }
      if (tinyWindow && !tinyWindow.isDestroyed()) {
        tinyWindow.closable = true;
        tinyWindow.close();
      }
    });

    handleWindowBounds();
  }

  app.on("ready", init);

  app.on("window-all-closed", () => {
    if (!isMac || shouldQuit) {
      app.quit();
    }
  });

  app.on("activate", () => {
    if (mainWindow === null) {
      createWindow();
    }
  });

  app.on("browser-window-blur", hideIfAutoHide);
  app.on("browser-window-focus", showIfAutoHide);

  app.on("before-quit", (event) => {
    const bounds = mainWindow.getBounds();
    store.set("x", bounds.x);
    store.set("y", bounds.y);
    store.set("width", bounds.width);
    store.set("height", bounds.height);

    shouldQuit = true;
  });

  ipcMain.on("log", (event, data) => {
    console.log(data);
  });

  function roundToNearestMultiple(number, multiple) {
    return (
      (number > 0
        ? Math.ceil(number / multiple)
        : Math.floor(number / multiple)) * multiple
    );
  }

  function relativeResize(event, delta, win) {
    win = win ? win : BrowserWindow.fromWebContents(event.sender);
    const bounds = win.getBounds();
    const ratio = bounds.width / bounds.height;
    delta = roundToNearestMultiple(delta, 2);

    const newWidth = Math.round(
      clamp(bounds.width + delta, minSquareSize, maxScreenWidth)
    );
    const newHeight = Math.round(
      clamp(
        bounds.height + Math.round(delta / ratio),
        minSquareSize,
        maxScreenHeight
      )
    );

    const xDelta = roundToNearestMultiple(newWidth - bounds.width, 2);
    const yDelta = roundToNearestMultiple(newHeight - bounds.height, 2);
    if (xDelta || yDelta) {
      bounds.x -= xDelta / 2;
      bounds.y -= yDelta / 2;
      bounds.width = newWidth;
      bounds.height = newHeight;
      win.setBounds(bounds);
    }
  }

  ipcMain.on("relativeResize", relativeResize);
  ipcMain.on("serverState", (event) => {
    event.reply("serverState", serverState);
  });

  ipcMain.on("bleCode", (event) => {
    event.sender.executeJavaScript("window.bleCode()", true);
  });

  ipcMain.on("forgetPairedDevice", (event) => {
    store.set("pairedId", false);
  });

  ipcMain.on("windowBounds", (event) => {
    event.reply("windowBounds", mainWindow.getBounds());
  });

  ipcMain.on("autoHide", (event, value) => {
    autoHide = value;
    // Have to trigger hideIfAutoHide manually too,
    // seems like blur event fires before autoHide is set
    hideIfAutoHide();
  });
}
