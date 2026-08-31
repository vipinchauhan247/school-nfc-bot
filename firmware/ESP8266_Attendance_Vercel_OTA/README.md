# ESP8266 Attendance Vercel OTA

## Files

- `ESP8266_Attendance_Vercel_OTA.ino` — main firmware
- `private_config.example.h` — copy to `private_config.h` and edit Wi-Fi + OTA password

## Auto sleep toggle

At top of `.ino`:

```cpp
#define DISABLE_AUTO_SLEEP true   // testing: box stays awake 24/7
#define DISABLE_AUTO_SLEEP false  // school: sleep 3:30 PM – 7:30 AM IST
```

All other features unchanged (OTA, battery, offline queue, dual Wi-Fi, buzzer, LEDs).

## Arduino IDE

- Board: NodeMCU 1.0 (ESP-12E)
- Libraries: Adafruit GFX, Adafruit SSD1306, ESP8266WiFi, ESP8266HTTPClient, ArduinoOTA, BearSSL

## Server

`https://school-nfc-bot.vercel.app/nfc`

Open `/warm` in browser before testing so cache is loaded.
