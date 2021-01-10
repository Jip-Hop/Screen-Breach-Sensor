/*
   Based on https://github.com/espressif/arduino-esp32/blob/master/libraries/BLE/examples/BLE_server_multiconnect/BLE_server_multiconnect.ino

   Prerequisites:
   - Install Arduino IDE
   - Intall ESP32 board and CP210x USB to UART Bridge VCP Drivers according to this tutorial: https://randomnerdtutorials.com/installing-the-esp32-board-in-arduino-ide-windows-instructions/
   - Select correct board and port in the Tools menu

   Creates a BLE server.
   The service advertises itself as: 932c32bd-0000-47a2-835a-a8d455b859dd
   And has a 4 writable characteristics.

   The design of creating the BLE server is:
   1. Create a BLE Server
   2. Create a BLE Service
   3. Create a BLE Characteristic on the Service
   4. Create a BLE Descriptor on the characteristic
   5. Start the service.
   6. Start advertising.
*/
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

BLEServer* pServer = NULL;
BLECharacteristic* tsCharacteristic  = NULL;
BLECharacteristic* acCharacteristic  = NULL;
BLECharacteristic* tc1Characteristic  = NULL;
BLECharacteristic* tc2Characteristic  = NULL;
bool deviceConnected = false;
bool oldDeviceConnected = false;

// See the following for generating UUIDs:
// https://www.uuidgenerator.net/

#define SERVICE_UUID        "932c32bd-0000-47a2-835a-a8d455b859dd"
#define TS_CHARACTERISTIC_UUID "b15120db-8583-4c33-b084-d7119aac42d9"
#define AC_CHARACTERISTIC_UUID "ce9ffbc8-4507-4264-946a-048f1fbfee62"
#define TC1_CHARACTERISTIC_UUID "92bb6856-2add-4119-a4a8-508b12f08786"
#define TC2_CHARACTERISTIC_UUID "dbee8b62-91a6-40e3-ab93-caea27650960"


class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
      deviceConnected = true;
      BLEDevice::startAdvertising();
    };

    void onDisconnect(BLEServer* pServer) {
      deviceConnected = false;
    }
};

class MyCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *tsCharacteristic ) {

      if (deviceConnected) {
        tsCharacteristic ->notify();
      }

      std::string value = tsCharacteristic ->getValue();

      Serial.println(value.c_str());

      if (value.c_str() == std::string("1")) {
        digitalWrite(LED_BUILTIN, HIGH);
      } else {
        digitalWrite(LED_BUILTIN, LOW);
      }
    }
};

class MyDemoCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *tsCharacteristic ) {

      if (deviceConnected) {
        tsCharacteristic ->notify();
      }

      std::string value = tsCharacteristic ->getValue();
      for (int i = 0; i < value.length(); i++)
        Serial.print(value[i]);
      Serial.println("");
    }
};

void setup() {
  Serial.begin(115200);

  // initialize digital pin LED_BUILTIN as an output.
  pinMode(LED_BUILTIN, OUTPUT);

  // Create the BLE Device
  BLEDevice::init("MyESP32");

  // Create the BLE Server
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  // Create the BLE Service
  BLEService *pService = pServer->createService(SERVICE_UUID);

  // Create a BLE Characteristic
  tsCharacteristic  = pService->createCharacteristic(
                        TS_CHARACTERISTIC_UUID,
                        BLECharacteristic::PROPERTY_READ   |
                        BLECharacteristic::PROPERTY_WRITE  |
                        BLECharacteristic::PROPERTY_NOTIFY |
                        BLECharacteristic::PROPERTY_INDICATE
                      );

  // https://www.bluetooth.com/specifications/gatt/viewer?attributeXmlFile=org.bluetooth.descriptor.gatt.client_characteristic_configuration.xml
  // Create a BLE Descriptor
  tsCharacteristic ->addDescriptor(new BLE2902());

  // Set the callbacks for the characteristic
  tsCharacteristic ->setCallbacks(new MyCallbacks());


  acCharacteristic  = pService->createCharacteristic(
                        AC_CHARACTERISTIC_UUID,
                        BLECharacteristic::PROPERTY_READ   |
                        BLECharacteristic::PROPERTY_WRITE  |
                        BLECharacteristic::PROPERTY_NOTIFY |
                        BLECharacteristic::PROPERTY_INDICATE
                      );
  acCharacteristic ->addDescriptor(new BLE2902());
  acCharacteristic ->setCallbacks(new MyDemoCallbacks());

  tc1Characteristic  = pService->createCharacteristic(
                         TC1_CHARACTERISTIC_UUID,
                         BLECharacteristic::PROPERTY_READ   |
                         BLECharacteristic::PROPERTY_WRITE  |
                         BLECharacteristic::PROPERTY_NOTIFY |
                         BLECharacteristic::PROPERTY_INDICATE
                       );
  tc1Characteristic ->addDescriptor(new BLE2902());
  tc1Characteristic ->setCallbacks(new MyDemoCallbacks());

  tc2Characteristic  = pService->createCharacteristic(
                         TC2_CHARACTERISTIC_UUID,
                         BLECharacteristic::PROPERTY_READ   |
                         BLECharacteristic::PROPERTY_WRITE  |
                         BLECharacteristic::PROPERTY_NOTIFY |
                         BLECharacteristic::PROPERTY_INDICATE
                       );
  tc2Characteristic ->addDescriptor(new BLE2902());
  tc2Characteristic ->setCallbacks(new MyDemoCallbacks());


  // Start the service
  pService->start();

  // Start advertising
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(false);
  pAdvertising->setMinPreferred(0x0);  // set value to 0x00 to not advertise this parameter
  BLEDevice::startAdvertising();
  Serial.println("Waiting a client connection to notify...");
}

void loop() {
  // disconnecting
  if (!deviceConnected && oldDeviceConnected) {
    delay(500); // give the bluetooth stack the chance to get things ready
    pServer->startAdvertising(); // restart advertising
    Serial.println("start advertising");
    oldDeviceConnected = deviceConnected;
  }
  // connecting
  if (deviceConnected && !oldDeviceConnected) {
    // do stuff here on connecting
    oldDeviceConnected = deviceConnected;
  }
}
