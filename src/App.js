import React, { PureComponent, Fragment } from "react";
// Instead of the NewWindow library I could follow this tutorial:
// https://medium.com/hackernoon/using-a-react-16-portal-to-do-something-cool-2a2d627b0202
import NewWindow from "react-new-window";
import FastAverageColor from "fast-average-color";
import chroma from "chroma-js";
import Form from "react-bootstrap/Form";
import InputGroup from "react-bootstrap/InputGroup";
import Card from "react-bootstrap/Card";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import "bootstrap/dist/css/bootstrap.min.css";
import "./App.css";

const Store = require("electron-store");
const store = new Store();
const { desktopCapturer, remote, ipcRenderer } = require("electron");
// TODO: move away from using remote
// https://github.com/electron/electron/issues/21408
const { screen, Menu, MenuItem, app } = remote;
const fac = new FastAverageColor();
const settingsWindowTitle = `${app.name} Settings`;

const fps = 30;
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const shouldImplementDrag = !isMac;
const currentWindow = remote.getCurrentWindow();
const defaultPortNumber = 8124;
const defaultDeviceName = "Hue Lamp";
const sensorWindowBorderSize = 2; // in pixels
const bleService = "932c32bd-0000-47a2-835a-a8d455b859dd";
const hueLampCharacteristicUuid = "932c32bd-0002-47a2-835a-a8d455b859dd";
const esp32TriggerStateCharacteristicUuid =
  "b15120db-8583-4c33-b084-d7119aac42d9";
const esp32AverageColorCharacteristicUuid =
  "ce9ffbc8-4507-4264-946a-048f1fbfee62";
const esp32TargetColor0CharacteristicUuid =
  "92bb6856-2add-4119-a4a8-508b12f08786";
const esp32TargetColor1CharacteristicUuid =
  "dbee8b62-91a6-40e3-ab93-caea27650960";

const convertArrayToObject = (array, key) => {
  const initialValue = {};
  return array.reduce((obj, item) => {
    return {
      ...obj,
      [item[key]]: item,
    };
  }, initialValue);
};

function str2ab(str) {
  var buf = new ArrayBuffer(str.length * 2); // 2 bytes for each char
  var bufView = new Uint16Array(buf);
  for (var i = 0, strLen = str.length; i < strLen; i++) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
}

function invertHex(hex) {
  return (
    "#" +
    (Number(`0x1${hex.substring(1)}`) ^ 0xffffff)
      .toString(16)
      .substr(1)
      .toUpperCase()
  );
}

function callBleCode() {
  ipcRenderer.send("bleCode");
}

// Plug in or toggle the unit to start pairing.
// If pairing the Philips Hue Smart Plug does not work,
// you probably need to reset it to factory defaults with the Hue BT smartphone app
window.bleCode = function () {
  const component = window.myAppComponent;

  if (
    !(
      component &&
      component.state.bluetoothEnabled &&
      (component.state.isPaired || component.state.willPair)
    )
  ) {
    return;
  }

  clearTimeout(component.bleTimer);
  var message = `Requesting device '${component.state.deviceName}'. Make sure bluetooth is enabled on this computer and your device.`;
  component.setStateIfChanged("bluetoothState", "connecting");
  component.setStateIfChanged("bluetoothStateMessage", message);

  function reconnect(delay) {
    if (component.bluetoothDevice) {
      component.bluetoothDevice.gatt.disconnect();
    }

    component.bluetoothDevice = null;
    component.cObj = null;

    if (delay) {
      component.bleTimer = setTimeout(callBleCode, delay);
    } else {
      callBleCode();
    }
  }

  function onDisconnected() {
    const message = "Bluetooth device disconnected";
    component.setStateIfChanged("bluetoothState", "connecting");
    component.setStateIfChanged("bluetoothStateMessage", message);

    reconnect(1000);
  }

  function shouldContinue(promise) {
    if (
      !(
        component.state.bluetoothEnabled &&
        (component.state.isPaired || component.state.willPair)
      )
    ) {
      return Promise.reject(
        new Error("Bluetooth preference has been disabled.")
      );
    }
    return promise;
  }

  navigator.bluetooth
    .requestDevice({
      filters: [{ name: [component.state.deviceName] }],
      optionalServices: [bleService],
    })
    .then(shouldContinue)
    .then((device) => {
      component.bluetoothDevice = device;
      component.bluetoothDevice.addEventListener(
        "gattserverdisconnected",
        onDisconnected
      );

      component.setState({
        willPair: false,
        isPaired: true,
        bluetoothState: "connecting",
        bluetoothStateMessage: "Connecting to bluetooth device...",
      });
      return device.gatt.connect();
    })
    .then(shouldContinue)
    .then((server) => {
      component.setState({
        bluetoothState: "success",
        bluetoothStateMessage: "Getting Service...",
      });

      return server.getPrimaryService(bleService);
    })
    .then(shouldContinue)
    .then((service) => {
      component.setState({
        bluetoothStateMessage: "Getting Characteristics...",
      });

      // Get all characteristics.
      return service.getCharacteristics();
    })
    .then(shouldContinue)
    .then((characteristics) => {
      component.cObj = convertArrayToObject(characteristics, "uuid");
      component.setState({
        bluetoothStateMessage: "Connected.",
      });
    })
    .catch((error) => {
      if (error.name === "NotFoundError") {
        // Ignore NotFoundError, probably bluetooth is turned off,
        // or no device available for chosen device name
        console.error(error.name, error);
      } else {
        component.setState({
          bluetoothState: "error",
          bluetoothStateMessage: error.toString(),
        });
      }

      reconnect(5000);
    });
};

class MyComponent extends PureComponent {
  setStateCallbacks = {};

  setStateIfChanged = (key, value) => {
    this.setState(
      function (state) {
        // Stop updates and re-renders if value hasn't changed.
        if (state[key] === value) {
          return null;
        }

        return {
          [key]: value,
        };
      },
      this.setStateCallbacks[key] instanceof Function
        ? function () {
            this.setStateCallbacks[key](key, value);
          }
        : null
    );
  };

  callAllSetStateCallbacks = () => {
    for (const key in this.setStateCallbacks) {
      const setStateCallback = this.setStateCallbacks[key];
      if (setStateCallback instanceof Function) {
        setStateCallback(key, this.state[key]);
      }
    }
  };
}

class TargetColorInFigure extends MyComponent {
  constructor(props) {
    super(props);

    this.state = {
      editMode: false,
    };
  }

  render() {
    return (
      <CustomFigure
        matched={this.props.matched}
        color={this.props.color}
        caption={
          <Fragment>
            {this.props.caption}
            <Button
              style={{
                display: "inline",
                fontSize: "inherit",
                padding: 0,
                paddingLeft: "5px",
                border: 0,
                lineHeight: "unset",
                verticalAlign: "unset",
              }}
              variant="link"
              onClick={() => this.props.handleColorChange()}
            >
              {"Sync"}
            </Button>
          </Fragment>
        }
      ></CustomFigure>
    );
  }
}

function CustomFigure(props) {
  var style = {
    width: "250px",
    height: "250px",
    boxSizing: "border-box",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    borderStyle: "solid",
  };

  var className;

  if (props.matched) {
    className = "border-primary";
    style.borderWidth = "3px";
  } else {
    className = "border-secondary";
    style.borderWidth = "1px";
  }

  if (props.img) {
    style.backgroundImage = `url("${props.img}")`;
    style.backgroundSize = "contain";
    style.imageRendering = "pixelated";
    style.backgroundPosition = "center center";
    style.backgroundRepeat = "no-repeat";
  }

  if (props.color) {
    style.backgroundColor = props.color;
  }

  return (
    <figure
      className="figure"
      style={{
        float: "left",
      }}
    >
      <div style={style} className={className}>
        {props.children}
      </div>
      {/* <p>{props.color}</p> */}

      <figcaption className="figure-caption">{props.caption}</figcaption>
    </figure>
  );
}

class TrackingSquare extends MyComponent {
  componentDidMount() {
    if (shouldImplementDrag) {
      const _this = this;
      window.addEventListener("mousedown", (mouseDownEvent) => {
        _this.initialBounds = currentWindow.getBounds();
        _this.pageX = mouseDownEvent.pageX;
        _this.pageY = mouseDownEvent.pageY;
        window.addEventListener("mousemove", _this.drag);
      });

      window.addEventListener("mouseup", () => {
        window.removeEventListener("mousemove", _this.drag);
      });
    }

    document.addEventListener("keydown", this.handleKeyDown);
  }

  handleKeyDown = (event) => {
    if(event.ctrlKey || event.metaKey){
      if (event.key === "0") {
        event.preventDefault();
        this.props.handleTargetColor0Change();
      } else if (event.key === "1") {
        event.preventDefault();
        this.props.handleTargetColor1Change();
      }
    }
  };

  drag = (mouseMoveEvent) => {
    mouseMoveEvent.stopPropagation();
    mouseMoveEvent.preventDefault();
    const { screenX, screenY } = mouseMoveEvent;

    currentWindow.setBounds({
      x: screenX - this.pageX,
      y: screenY - this.pageY,
      width: this.initialBounds.width,
      height: this.initialBounds.height,
    });
  };

  render() {
    return (
      <Fragment>
        <div
          className="sensor-border"
          style={{
            border: `solid ${sensorWindowBorderSize}px black`,
            borderColor: invertHex(this.props.color),
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            /*
              Background color workaround for Windows.
              Inside of sensor rectangle should not be fully transparent,
              else no pointer events will be captured
            */
            backgroundColor: isWin
              ? "rgba(128, 128, 128, 0.01)"
              : "transparent",
            /*
              Make a 1px transparent area around the canvas,
              to prevent picking up the border color
             */
            padding: "1px",
            WebkitAppRegion: shouldImplementDrag ? "no-drag" : "drag",
            WebkitUserSelect: "none",
            cursor: "move",
          }}
        >
          <canvas
            ref={(c) => {
              this.props.setCanvas(c);
            }}
            style={{
              width: "100%",
              height: "100%",
              opacity: 0,
              display: "block",
            }}
          ></canvas>
        </div>
      </Fragment>
    );
  }
}

class Settings extends MyComponent {
  constructor(props) {
    super(props);
  }

  componentDidMount() {
    this.props.windowRef.current.window.document.addEventListener(
      "keydown",
      this.handleKeyDown
    );
  }

  handleKeyDown = (event) => {
    if(event.ctrlKey || event.metaKey){
      if (event.key === "0") {
        event.preventDefault();
        this.props.handleTargetColor0Change();
      } else if (event.key === "1") {
        event.preventDefault();
        this.props.handleTargetColor1Change();
      }
    }
  };

  render() {
    const isPaired = this.props.isPaired;
    const willPair = this.props.willPair;
    let button;

    if (isPaired) {
      button = (
        <Button size="sm" onClick={this.props.handleBluetoothForget}>
          Forget
        </Button>
      );
    } else if (willPair) {
      button = (
        <Button size="sm" onClick={this.props.handleBluetoothForget}>
          Cancel
        </Button>
      );
    } else {
      button = (
        <Button size="sm" onClick={this.props.handleBluetoothPair}>
          Pair
        </Button>
      );
    }

    return (
      <Card
        style={{
          userSelect: "none",
        }}
      >
        {isMac && (
          <Card.Header
            style={{
              WebkitAppRegion: "drag",
              WebkitUserSelect: "none",
              padding: 0,
              height: "20px",
              lineHeight: "20px",
              fontSize: "12px",
              textAlign: "center",
            }}
          >
            {settingsWindowTitle}
          </Card.Header>
        )}
        <Card.Body>
          <div className="clearfix">
            <Card.Title>Live Tracking</Card.Title>

            <CustomFigure
              img={this.props.img}
              caption="Live pixels"
            ></CustomFigure>
            <CustomFigure
              color={this.props.color}
              caption="Live color"
            ></CustomFigure>
          </div>
          <div className="clearfix">
            <Card.Title>Target Colors</Card.Title>

            <TargetColorInFigure
              matched={this.props.triggerState === 0}
              color={this.props.targetColor0}
              caption={
                <Fragment>
                  Target color <span className="text-monospace">0</span>
                </Fragment>
              }
              handleColorChange={this.props.handleTargetColor0Change}
            ></TargetColorInFigure>

            <TargetColorInFigure
              matched={this.props.triggerState === 1}
              color={this.props.targetColor1}
              caption={
                <Fragment>
                  Target color <span className="text-monospace">1</span>
                </Fragment>
              }
              handleColorChange={this.props.handleTargetColor1Change}
            ></TargetColorInFigure>
          </div>
          <div className="clearfix">
            <Card.Title>
              Triggered State:{" "}
              <span className="text-monospace">{this.props.triggerState}</span>
            </Card.Title>
            <p>
              The <em>Live color</em> is closest to{" "}
              <em>
                Target color{" "}
                <span className="text-monospace">
                  {this.props.triggerState}
                </span>
              </em>
              .
            </p>
          </div>
          <div className="clearfix">
            <Card.Title>Connectivity</Card.Title>

            <div
              style={{
                width: "250px",
                float: "left",
                marginRight: "25px",
              }}
            >
              <Form.Check
                type="switch"
                id="serverEnabled"
                name="serverEnabled"
                label="HTTP Server"
                onChange={this.props.handleCheckboxChange}
                checked={this.props.serverEnabled}
              />
              <Form.Label className="my-1 mr-2 figure-caption">
                Port number
              </Form.Label>

              <InputGroup className="mb-3">
                <Form.Control
                  type="number"
                  min="1"
                  max="65535"
                  name="portNumber"
                  onChange={this.props.handleValueChange}
                  value={this.props.portNumber}
                  placeholder={defaultPortNumber}
                  size="sm"
                />
              </InputGroup>

              {this.props.serverEnabled && (
                <Alert
                  variant={this.props.serverStateError ? "danger" : "success"}
                >
                  {this.props.serverStateMessage}
                </Alert>
              )}
            </div>

            <div
              style={{
                width: "250px",
                float: "left",
              }}
            >
              <Form.Check
                type="switch"
                id="bluetoothEnabled"
                name="bluetoothEnabled"
                label="Bluetooth"
                onChange={this.props.handleCheckboxChange}
                checked={this.props.bluetoothEnabled}
              />
              <Form.Label className="my-1 mr-2 figure-caption">
                Device name
              </Form.Label>

              <InputGroup className="mb-3">
                <Form.Control
                  type="text"
                  name="deviceName"
                  onChange={this.props.handleValueChange}
                  value={this.props.deviceName}
                  placeholder={defaultDeviceName}
                  size="sm"
                  disabled={isPaired || willPair ? true : false}
                />
                <InputGroup.Append>{button}</InputGroup.Append>
              </InputGroup>
              {this.props.bluetoothEnabled && (isPaired || willPair) && (
                <Alert
                  variant={
                    this.props.bluetoothState === "error"
                      ? "danger"
                      : this.props.bluetoothState === "success"
                      ? "success"
                      : "warning"
                  }
                >
                  {this.props.bluetoothStateMessage}
                </Alert>
              )}
            </div>
          </div>
        </Card.Body>
      </Card>
    );
  }
}

class App extends MyComponent {
  constructor(props) {
    super(props);
    window.myAppComponent = this;

    this.currentDisplay = screen.getDisplayMatching(currentWindow.getBounds());
    this.video = document.createElement("video");
    this.fpsTimer = null;

    this.state = {
      color: "#000",
      img: null,
      showSettings: false,
      targetColor0: store.get("targetColor0", "#000"),
      targetColor1: store.get("targetColor1", "#fff"),
      triggerState: 0,
      serverEnabled: store.get("serverEnabled", false),
      portNumber: store.get("portNumber", defaultPortNumber),
      serverStateError: false,
      serverStateMessage: "",
      bluetoothEnabled: store.get("bluetoothEnabled", false),
      deviceName: store.get("deviceName", defaultDeviceName),
      bluetoothState: "",
      bluetoothStateMessage: "",
      autoHide: store.get("autoHide", false),
      isPaired: store.get("pairedId", false),
      willPair: false,
    };

    this.ref = React.createRef();
  }

  componentDidMount() {
    const menu = (this.menu = new Menu());

    menu.append(
      new MenuItem({
        id: "showSettings",
        label: "Show Settings",
        type: "checkbox",
        click: this.toggleMenuItem,
      })
    );
    menu.append(new MenuItem({ type: "separator" }));
    menu.append(
      new MenuItem({
        id: "autoHide",
        label: "Auto Hide",
        type: "checkbox",
        click: this.toggleMenuItem,
      })
    );
    menu.append(new MenuItem({ type: "separator" }));
    menu.append(
      new MenuItem({
        label: "Quit",
        role: "quit",
      })
    );

    this.setStateCallbacks["serverEnabled"] = this.handleServerToggle;
    this.setStateCallbacks["bluetoothEnabled"] = this.handleBluetoothToggle;
    this.setStateCallbacks["portNumber"] = this.handleServerPortChange;
    this.setStateCallbacks["deviceName"] = this.storeStateValue;

    this.setStateCallbacks["targetColor0"] = this.storeStateValue;
    this.setStateCallbacks["targetColor1"] = this.storeStateValue;
    this.setStateCallbacks["autoHide"] = this.handleAutoHidePreferenceChanged;
    this.setStateCallbacks["showSettings"] = this.updateMenuItemCheckbox;

    this.callAllSetStateCallbacks();

    window.oncontextmenu = function (e) {
      e.preventDefault();
      menu.popup({ window: currentWindow });
    };

    ipcRenderer.on("serverState", (event, serverState) => {
      this.setStateIfChanged("serverStateError", serverState.error);
      this.setStateIfChanged("serverStateMessage", serverState.message);
    });

    ipcRenderer.on("windowBounds", this.handleWindowBounds);

    window.addEventListener("beforeunload", () => {
      ipcRenderer.removeAllListeners("serverState");
    });

    // Request serverState and windowBounds
    ipcRenderer.send("serverState");
    ipcRenderer.send("windowBounds");

    const _this = this;

    function captureDesktop() {
      clearTimeout(_this.fpsTimer);
      if (_this.stream) {
        _this.stream.getTracks().forEach((track) => track.stop());
      }
      desktopCapturer
        .getSources({
          types: ["screen"],
          thumbnailSize: { width: 0, height: 0 },
        })
        .then(async (sources) => {
          const currentDisplay = screen.getDisplayMatching(
            currentWindow.getBounds()
          );

          var source = sources.find((source) => {
            return source.display_id === currentDisplay.id.toString();
          });

          if (!source) {
            let displays = screen.getAllDisplays();
            var displayIndex = 0;
            for (displayIndex in displays) {
              const display = displays[displayIndex];
              if (display.id === currentDisplay.id) {
                break;
              }
            }
            source = sources[displayIndex];
          }

          _this.stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              mandatory: {
                chromeMediaSource: "desktop",
                chromeMediaSourceId: source.id,
                maxFrameRate: fps,
                maxWidth: _this.currentDisplay.size.width,
                maxHeight: _this.currentDisplay.size.height,
                minWidth: _this.currentDisplay.size.width,
                minHeight: _this.currentDisplay.size.height,
              },
            },
          });

          const video = _this.video;

          _this.fpsTimer = setInterval(function () {
            const currentDisplay = screen.getDisplayMatching(
              currentWindow.getBounds()
            );
            if (
              JSON.stringify(currentDisplay) !==
              JSON.stringify(_this.currentDisplay)
            ) {
              // restart capture
              _this.currentDisplay = currentDisplay;
              return captureDesktop();
            }

            const canvas = _this.canvas;
            const ctx = canvas.getContext("2d");
            const sensorRect = canvas.getBoundingClientRect();
            canvas.width = sensorRect.width || 1;
            canvas.height = sensorRect.height || 1;
            // Add 1px margin on each sides to prevent capturing the sensor border
            const sx =
              _this.x - currentDisplay.bounds.x + sensorWindowBorderSize + 1;
            const sy =
              _this.y - currentDisplay.bounds.y + sensorWindowBorderSize + 1;
            const sWidth = _this.width - sensorWindowBorderSize * 2 - 2;
            const sHeight = _this.height - sensorWindowBorderSize * 2 - 2;

            ctx.drawImage(
              video,
              sx,
              sy,
              sWidth,
              sHeight,
              0,
              0,
              canvas.width,
              canvas.height
            );

            const color = fac.getColor(canvas, {
              mode: "precision",
              algorithm: "simple",
            });

            var triggerState =
              chroma.distance(_this.state.targetColor0, color.hex, "rgb") >
              chroma.distance(_this.state.targetColor1, color.hex, "rgb")
                ? 1
                : 0;
            _this.setStateIfChanged("triggerState", triggerState);

            if (_this.cObj) {
              const cObj = _this.cObj;

              const hueLampCharacteristic = cObj[hueLampCharacteristicUuid];

              if (hueLampCharacteristic) {
                var buffer = new ArrayBuffer(1);
                // Creating a view with slot from 0 to 1
                var dataview1 = new DataView(buffer, 0, 1);
                // put the new value at slot 1
                dataview1.setUint8(0, _this.state.triggerState);
                hueLampCharacteristic
                  .writeValue(dataview1.buffer)
                  .catch((error) => {
                    console.error(error);
                  });
              }

              const esp32TriggerStateCharacteristic =
                cObj[esp32TriggerStateCharacteristicUuid];

              if (esp32TriggerStateCharacteristic) {
                esp32TriggerStateCharacteristic
                  .writeValue(str2ab(_this.state.triggerState.toString()))
                  .catch((error) => {
                    console.error(error);
                  });
              }

              const esp32AverageColorCharacteristic =
                cObj[esp32AverageColorCharacteristicUuid];

              if (esp32AverageColorCharacteristic) {
                esp32AverageColorCharacteristic
                  .writeValue(str2ab(_this.state.color.toString()))
                  .catch((error) => {
                    console.error(error);
                  });
              }

              const esp32TargetColor0Characteristic =
                cObj[esp32TargetColor0CharacteristicUuid];

              if (esp32TargetColor0Characteristic) {
                esp32TargetColor0Characteristic
                  .writeValue(str2ab(_this.state.targetColor0.toString()))
                  .catch((error) => {
                    console.error(error);
                  });
              }

              const esp32TargetColor1Characteristic =
                cObj[esp32TargetColor1CharacteristicUuid];

              if (esp32TargetColor1Characteristic) {
                esp32TargetColor1Characteristic
                  .writeValue(str2ab(_this.state.targetColor1.toString()))
                  .catch((error) => {
                    console.error(error);
                  });
              }
            }

            ipcRenderer.send("data", {
              state: triggerState,
              color: color.hex,
            });

            _this.setStateIfChanged("color", color.hex);
            _this.setStateIfChanged("img", canvas.toDataURL("image/png"));
          }, 1000 / fps);

          video.onloadedmetadata = function () {
            video.play();
          };

          video.srcObject = _this.stream;
        });
    }

    captureDesktop();
  }

  handleWindowBounds = (event, winBounds) => {
    this.x = winBounds.x;
    this.y = winBounds.y;
    this.width = winBounds.width;
    this.height = winBounds.height;
  };

  handleBluetoothToggle = (key, value) => {
    if (value) {
      if (this.state.isPaired) {
        callBleCode();
      }
    } else {
      this.setState(
        {
          willPair: false,
        },
        () => {
          clearTimeout(this.bleTimer);
          if (this.bluetoothDevice) {
            this.bluetoothDevice.gatt.disconnect();
          }
        }
      );
    }

    this.storeStateValue(key, value);
  };

  handleBluetoothForget = () => {
    this.setState(
      {
        isPaired: false,
        willPair: false,
      },
      () => {
        if (this.bluetoothDevice) {
          this.bluetoothDevice.gatt.disconnect();
        }
        ipcRenderer.send("forgetPairedDevice");
      }
    );
  };

  handleBluetoothPair = () => {
    clearTimeout(this.bleTimer);
    this.setState(
      {
        bluetoothState: "connecting",
        bluetoothStateMessage: "Requesting bluetooth device...",
        willPair: true,
      },
      callBleCode
    );
  };

  handleServerToggle = (key, value) => {
    if (value) {
      ipcRenderer.send("start-server", { port: this.state.portNumber });
    } else {
      ipcRenderer.send("stop-server");
    }
    this.storeStateValue(key, value);
  };

  handleServerPortChange = (key, value) => {
    if (this.state.serverEnabled) {
      ipcRenderer.send("stop-server");
      ipcRenderer.send("start-server", { port: value });
    }
    this.storeStateValue(key, value);
  };

  storeStateValue = (key, value) => {
    store.set(key, value);
  };

  closeSettingsMenu = () => {
    this.setStateIfChanged("showSettings", false);
  };

  toggleMenuItem = (event) => {
    const key = event.id;
    const newState = !this.state[key];
    this.setStateIfChanged(key, newState);
  };

  handleAutoHidePreferenceChanged = (key, value) => {
    this.updateMenuItemCheckbox(key, value);
    this.storeStateValue(key, value);
    ipcRenderer.send("autoHide", value);
  };

  updateMenuItemCheckbox = (key, value) => {
    this.menu.getMenuItemById(key).checked = value;
  };

  handleTargetColor0Change = () => {
    this.setStateIfChanged("targetColor0", this.state.color);
  };

  handleTargetColor1Change = () => {
    this.setStateIfChanged("targetColor1", this.state.color);
  };

  handleCheckboxChange = (event) => {
    const target = event.target;
    const checked = target.checked;
    const name = target.name;
    this.setStateIfChanged(name, checked);
  };

  handleValueChange = (event) => {
    const target = event.target;
    const name = target.name;
    var value = target.value;

    if (value === "") {
      value = target.placeholder;
    }

    if (target.type === "number") {
      value = parseInt(value);
      const min = parseInt(target.min);
      const max = parseInt(target.max);
      value = Math.min(Math.max(value, min), max);
    }

    this.setStateIfChanged(name, value);
  };

  setCanvas = (canvas) => {
    this.canvas = canvas;
    if (canvas) {
      canvas.onwheel = function (event) {
        ipcRenderer.send("relativeResize", event.deltaY);
      };
    }
  };

  render() {
    return (
      <Fragment>
        <TrackingSquare
          color={this.state.color}
          setStateIfChanged={this.setStateIfChanged}
          setCanvas={this.setCanvas}
          handleTargetColor0Change={this.handleTargetColor0Change}
          handleTargetColor1Change={this.handleTargetColor1Change}
        ></TrackingSquare>
        {this.state.showSettings && (
          <NewWindow onUnload={this.closeSettingsMenu} ref={this.ref}>
            <Settings
              windowRef={this.ref}
              img={this.state.img}
              color={this.state.color}
              triggerState={this.state.triggerState}
              targetColor0={this.state.targetColor0}
              handleTargetColor0Change={this.handleTargetColor0Change}
              targetColor1={this.state.targetColor1}
              handleTargetColor1Change={this.handleTargetColor1Change}
              handleCheckboxChange={this.handleCheckboxChange}
              handleValueChange={this.handleValueChange}
              serverEnabled={this.state.serverEnabled}
              portNumber={this.state.portNumber}
              serverStateError={this.state.serverStateError}
              serverStateMessage={this.state.serverStateMessage}
              bluetoothEnabled={this.state.bluetoothEnabled}
              isPaired={this.state.isPaired}
              willPair={this.state.willPair}
              deviceName={this.state.deviceName}
              handleBluetoothForget={this.handleBluetoothForget}
              handleBluetoothPair={this.handleBluetoothPair}
              bluetoothState={this.state.bluetoothState}
              bluetoothStateMessage={this.state.bluetoothStateMessage}
            ></Settings>
          </NewWindow>
        )}
      </Fragment>
    );
  }
}

export default App;
