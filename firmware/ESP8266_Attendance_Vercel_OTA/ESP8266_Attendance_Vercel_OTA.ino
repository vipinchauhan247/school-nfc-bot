/**
 * School NFC Attendance System - Compact Universal OLED Firmware
 * File: ESP8266_Attendance_Vercel_OTA.ino
 *
 * Features:
 *  - Password-protected OTA firmware updates with OLED progress
 *  - Best-effort RAM queue while Wi-Fi is unavailable
 *  - Battery % & Battery Icon Display (A0 Sense Pin with 100k Resistor)
 *  - Automatic 3:30 PM to 7:30 AM IST Deep Sleep (Saves power outside school hours)
 *  - Multi-network Wi-Fi failover
 *  - Strict server-response validation (never reports false attendance success)
 *  - Compact 4-Line Universal OLED (Fits 100% inside Dual-color screens)
 *  - PN532 Direct I2C Driver
 *
 * Before flashing: copy private_config.example.h to private_config.h and edit.
 */

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecureBearSSL.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ArduinoOTA.h>
#include <time.h>
#include "private_config.h"

// ============================================================================
// CLOUD CONFIGURATION
// ============================================================================
const char* FIRMWARE_VERSION = "MMM-NFC-V2-20260831";
const char* ATTENDANCE_SERVER_URL = "https://school-nfc-bot.vercel.app/nfc";

// false = normal school mode (deep sleep 3:30 PM - 7:30 AM IST)
// true  = stay awake 24/7 for bench testing
#define DISABLE_AUTO_SLEEP true

#define BUZZER_ACTIVE_HIGH false // Active-LOW Buzzer (Silent at HIGH 3.3V)

// Hardware Pins
#define I2C_SDA_PIN D2 // GPIO 4 (PN532 & OLED SDA)
#define I2C_SCL_PIN D1 // GPIO 5 (PN532 & OLED SCL)
#define BUZZER_PIN  D5 // GPIO 14 (Buzzer)
#define LED_RED_PIN   D6 // GPIO 12 (Red LED)
#define LED_GREEN_PIN D7 // GPIO 13 (Green LED)
#define BATTERY_PIN   A0 // Analog Battery sense pin (100k series resistor)

#define PN532_ADDR   0x24
#define OLED_ADDRESS 0x3C
#define SCREEN_WIDTH  128
#define SCREEN_HEIGHT 64
#define OLED_RESET    -1

#define SCAN_DEBOUNCE_MS 2000

// Battery calibration for one 3.7 V lithium cell (4.2 V fully charged), a
// NodeMCU 1.0 onboard 220k/100k ADC divider, and an extra 100k series resistor
// from battery positive to A0. Change these only after measuring the real cell.
const float BATTERY_ADC_VOLTAGE_AT_1023 = 4.20f;

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
unsigned long lastScanTime = 0;
unsigned long lastTimeCheck = 0;
unsigned long lastQueueFlush = 0;
bool isOtaUpdating = false;
bool otaInitialized = false;

// ============================================================================
// OFFLINE QUEUE BUFFER (HOLDS UP TO 100 SCANS IN RAM)
// ============================================================================
#define MAX_OFFLINE_SCANS 100

struct OfflineScan {
  String uid;
};

OfflineScan offlineQueue[MAX_OFFLINE_SCANS];
int queueCount = 0;

void enqueueOfflineScan(String uidStr) {
  for (int i = 0; i < queueCount; i++) {
    if (offlineQueue[i].uid == uidStr) {
      Serial.println("[OFFLINE] UID already pending; not queued twice.");
      return;
    }
  }
  if (queueCount < MAX_OFFLINE_SCANS) {
    offlineQueue[queueCount].uid = uidStr;
    queueCount++;
    Serial.println("[OFFLINE] Stored in queue! Total pending: " + String(queueCount));
  } else {
    Serial.println("[OFFLINE] Queue full!");
  }
}

// ============================================================================
// BATTERY MEASUREMENT (A0 with external 100k + NodeMCU onboard divider)
// ============================================================================
int lithiumPercentFromVoltage(float voltage) {
  struct BatteryPoint {
    float voltage;
    int percent;
  };

  static const BatteryPoint curve[] = {
    {4.20f, 100}, {4.10f, 90}, {4.00f, 80}, {3.92f, 70},
    {3.85f, 60},  {3.79f, 50}, {3.73f, 40}, {3.67f, 30},
    {3.60f, 20},  {3.45f, 10}, {3.30f, 0}
  };
  const size_t pointCount = sizeof(curve) / sizeof(curve[0]);

  if (voltage >= curve[0].voltage) return 100;
  if (voltage <= curve[pointCount - 1].voltage) return 0;

  for (size_t i = 1; i < pointCount; i++) {
    if (voltage >= curve[i].voltage) {
      float span = curve[i - 1].voltage - curve[i].voltage;
      float position = (voltage - curve[i].voltage) / span;
      float percent = curve[i].percent +
                      position * (curve[i - 1].percent - curve[i].percent);
      return constrain((int)(percent + 0.5f), 0, 100);
    }
  }
  return 0;
}

int getBatteryPercentage() {
  long rawSum = 0;
  for (int i = 0; i < 20; i++) {
    rawSum += analogRead(BATTERY_PIN);
    delay(2);
  }
  float avgRaw = rawSum / 20.0f;
  float batteryVoltage = avgRaw * BATTERY_ADC_VOLTAGE_AT_1023 / 1023.0f;
  int percent = lithiumPercentFromVoltage(batteryVoltage);
  Serial.println(String("[BATTERY] raw=") + String(avgRaw, 1) +
                 " voltage=" + String(batteryVoltage, 2) +
                 "V percent=" + String(percent) + "%");
  return percent;
}

void drawBatteryIcon(int x, int y, int percent) {
  display.drawRect(x, y + 1, 14, 7, SSD1306_WHITE);
  display.drawFastVLine(x + 14, y + 3, 3, SSD1306_WHITE);
  int fillWidth = map(percent, 0, 100, 0, 10);
  if (fillWidth > 0) {
    display.fillRect(x + 2, y + 3, fillWidth, 3, SSD1306_WHITE);
  }
  display.setTextSize(1);
  display.setCursor(x - 22, y);
  if (percent < 10) display.print(" ");
  display.print(String(percent) + "%");
}

// ============================================================================
// AUDIO & LED HELPERS
// ============================================================================
void setBiColorLed(bool redOn, bool greenOn) {
  digitalWrite(LED_RED_PIN, redOn ? HIGH : LOW);
  digitalWrite(LED_GREEN_PIN, greenOn ? HIGH : LOW);
}

void silenceBuzzer() {
  noTone(BUZZER_PIN);
  digitalWrite(BUZZER_PIN, HIGH);
}

void soundTone(int frequency, int durationMs) {
  digitalWrite(BUZZER_PIN, LOW);
  delay(durationMs);
  silenceBuzzer();
}

void playSoundSuccess() {
  setBiColorLed(false, true);
  soundTone(2000, 100);
  delay(80);
  soundTone(2000, 100);
}

void playSoundInvalidCard() {
  setBiColorLed(true, false);
  soundTone(500, 800);
}

void playSoundDuplicate() {
  setBiColorLed(true, false);
  soundTone(1200, 80);
  delay(60);
  soundTone(1200, 80);
  delay(60);
  soundTone(1200, 80);
}

// ============================================================================
// DISPLAY & ASCII SANITIZER
// ============================================================================
String sanitizeAscii(String input) {
  String clean = "";
  for (unsigned int i = 0; i < input.length(); i++) {
    char c = input.charAt(i);
    if (c >= 32 && c <= 126) clean += c;
  }
  clean.trim();
  if (clean.length() > 20) clean = clean.substring(0, 20);
  return clean;
}

void drawCenteredText(const char* text, int y) {
  if (!text) return;
  String str = sanitizeAscii(String(text));
  if (str.length() == 0) return;
  int x = (128 - (str.length() * 6)) / 2;
  if (x < 0) x = 0;
  display.setCursor(x, y);
  display.print(str);
}

void showMessageCompact(const char* title, const char* nameStr, const char* msgBottom) {
  if (isOtaUpdating) return;
  Wire.setClock(50000);
  display.clearDisplay();
  display.cp437(true);
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(0, 0);
  display.print("MMM Jr High");
  int batPercent = getBatteryPercentage();
  drawBatteryIcon(112, 0, batPercent);
  display.drawLine(0, 10, 128, 10, SSD1306_WHITE);

  drawCenteredText(title, 16);
  drawCenteredText(nameStr, 28);
  drawCenteredText(msgBottom, 40);

  display.display();
}

void renderReadyScreen() {
  if (isOtaUpdating) return;
  setBiColorLed(false, false);

  if (queueCount > 0) {
    String qMsg = "Pending: " + String(queueCount) + " Offline";
    showMessageCompact("Ready to Scan...", "Tap NFC Card below", qMsg.c_str());
  } else {
    String connectedWiFi = WiFi.SSID();
    if (connectedWiFi.length() == 0) {
      connectedWiFi = "No WiFi";
    }
    showMessageCompact("Ready to Scan...", "Tap NFC Card below", connectedWiFi.c_str());
  }
}

// ============================================================================
// BOOT ANIMATION
// ============================================================================
void playWelcomeBootAnimation() {
  for (int w = 0; w <= 128; w += 8) {
    display.clearDisplay();
    display.cp437(true);
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(8, 8);
    display.print("Madan Mohan Malviya");
    display.setCursor(18, 20);
    display.print("Jr High School");
    display.drawLine((128 - w) / 2, 34, (128 + w) / 2, 34, SSD1306_WHITE);
    display.display();
    delay(20);
  }

  delay(300);
  display.setCursor(16, 42);
  display.print("[ SYSTEM READY ]");
  display.display();

  setBiColorLed(false, true);
  soundTone(2000, 100);
  delay(80);
  soundTone(2500, 150);
  delay(600);
  setBiColorLed(false, false);
}

// ============================================================================
// AUTOMATIC OVERNIGHT DEEP SLEEP (3:30 PM to 7:30 AM IST)
// ============================================================================
void triggerAutoDeepSleep(uint64_t sleepSeconds) {
  if (isOtaUpdating) return;
  display.clearDisplay();
  display.cp437(true);
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(8, 15);
  display.print("Madan Mohan Malviya");
  display.setCursor(18, 28);
  display.print("[ SYSTEM SLEEP ]");
  display.setCursor(8, 42);
  display.print("Next sleep cycle...");
  display.display();

  soundTone(1200, 200);
  delay(100);
  soundTone(800, 400);
  delay(2000);

  display.ssd1306_command(SSD1306_DISPLAYOFF);
  setBiColorLed(false, false);
  silenceBuzzer();

  uint64_t requestedUs = sleepSeconds * 1000000ULL;
  uint64_t maximumUs = ESP.deepSleepMax();
  uint64_t safeMaximumUs =
      maximumUs > 60000000ULL ? maximumUs - 60000000ULL : maximumUs;
  uint64_t actualUs = requestedUs < safeMaximumUs ? requestedUs : safeMaximumUs;
  Serial.println("\n[SLEEP] Requested " + String((unsigned long)sleepSeconds) +
                 "s; sleeping this cycle for " +
                 String((unsigned long)(actualUs / 1000000ULL)) + "s.");
  ESP.deepSleep(actualUs, WAKE_RF_DEFAULT);
}

void checkOvernightSchedule() {
#if DISABLE_AUTO_SLEEP
  return;
#endif
  if (isOtaUpdating) return;
  if (queueCount > 0) return;

  time_t now = time(nullptr);
  struct tm* ptm = localtime(&now);
  if (!ptm || ptm->tm_year < 120) return;

  int currentHour = ptm->tm_hour;
  int currentMin = ptm->tm_min;

  if ((currentHour == 15 && currentMin >= 30) || (currentHour > 15) ||
      (currentHour < 7) || (currentHour == 7 && currentMin < 30)) {
    int targetHour = 7;
    int targetMin = 30;

    int hoursToSleep = (targetHour - currentHour + 24) % 24;
    int minsToSleep = targetMin - currentMin;
    long totalSleepSeconds = (hoursToSleep * 3600) + (minsToSleep * 60);

    if (totalSleepSeconds < 300) totalSleepSeconds = 300;

    Serial.println("[TIMER] School Closed at 3:30 PM. Sleeping until 7:30 AM (" +
                   String(totalSleepSeconds) + "s)");
    triggerAutoDeepSleep(totalSleepSeconds);
  }
}

// ============================================================================
// DIRECT PN532 I2C HARDWARE DRIVER
// ============================================================================
bool pn532SendCommand(uint8_t* cmd, uint8_t cmdLen) {
  Wire.setClock(50000);
  Wire.beginTransmission(PN532_ADDR);
  uint8_t checksum = 0;
  Wire.write(0x00);
  Wire.write(0x00);
  Wire.write(0xFF);
  uint8_t length = cmdLen + 1;
  Wire.write(length);
  Wire.write(~length + 1);
  Wire.write(0xD4);
  checksum += 0xD4;
  for (uint8_t i = 0; i < cmdLen; i++) {
    Wire.write(cmd[i]);
    checksum += cmd[i];
  }
  Wire.write(~checksum + 1);
  Wire.write(0x00);
  if (Wire.endTransmission() != 0) return false;
  delay(5);
  Wire.requestFrom(PN532_ADDR, 7);
  uint8_t idx = 0;
  while (Wire.available() && idx < 7) Wire.read();
  return true;
}

void pn532WakeupOnce() {
  Wire.beginTransmission(PN532_ADDR);
  Wire.write(0x55);
  Wire.write(0x55);
  Wire.write(0x00);
  Wire.write(0x00);
  Wire.write(0x00);
  Wire.endTransmission();
  delay(50);
}

void pn532InitSAM() {
  uint8_t cmd[] = {0x14, 0x01, 0x14, 0x01};
  pn532SendCommand(cmd, sizeof(cmd));
  delay(50);
}

String pn532ReadPassiveCard() {
  uint8_t cmd[] = {0x4A, 0x01, 0x00};
  if (!pn532SendCommand(cmd, sizeof(cmd))) return "";
  delay(30);
  Wire.requestFrom(PN532_ADDR, 26);
  uint8_t buf[26];
  uint8_t idx = 0;
  while (Wire.available() && idx < 26) buf[idx++] = Wire.read();
  if (idx >= 12) {
    for (int k = 0; k < idx - 5; k++) {
      if (buf[k] == 0xD5 && buf[k + 1] == 0x4B && buf[k + 2] >= 0x01) {
        uint8_t uidLen = buf[k + 7];
        if (uidLen >= 4 && uidLen <= 7 && (k + 8 + uidLen) <= idx) {
          String uidStr = "";
          for (uint8_t i = 0; i < uidLen; i++) {
            if (i > 0) uidStr += ":";
            if (buf[k + 8 + i] < 0x10) uidStr += "0";
            uidStr += String(buf[k + 8 + i], HEX);
          }
          uidStr.toUpperCase();
          return uidStr;
        }
      }
    }
  }
  return "";
}

// ============================================================================
// DUAL WI-FI WITH IST TIME SYNC & ARDUINO OTA SETUP
// ============================================================================
void setupArduinoOta() {
  if (otaInitialized) return;
  ArduinoOTA.setHostname("MMM-NFC-Gate");
  ArduinoOTA.setPassword(OTA_PASSWORD);

  ArduinoOTA.onStart([]() {
    isOtaUpdating = true;
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(16, 12);
    display.print("[ OTA UPDATE ]");
    display.setCursor(12, 28);
    display.print("Flashing Code...");
    display.drawRect(10, 44, 108, 10, SSD1306_WHITE);
    display.display();
  });

  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    int percent = total > 0 ? (progress * 100U) / total : 0;
    int barWidth = map(percent, 0, 100, 0, 104);
    display.fillRect(12, 46, barWidth, 6, SSD1306_WHITE);
    display.setCursor(50, 28);
    display.print(String(percent) + "%");
    display.display();
  });

  ArduinoOTA.onEnd([]() {
    display.clearDisplay();
    display.setCursor(16, 26);
    display.print("[ UPDATE DONE! ]");
    display.setCursor(24, 40);
    display.print("Rebooting...");
    display.display();
    delay(1000);
  });

  ArduinoOTA.onError([](ota_error_t error) {
    isOtaUpdating = false;
    Serial.printf("OTA Error[%u]: ", error);
  });

  ArduinoOTA.begin();
  otaInitialized = true;
  Serial.println("[OTA] ArduinoOTA Wireless Updating Ready!");
}

void connectToWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);

  for (size_t networkIndex = 0;
       networkIndex < WIFI_NETWORK_COUNT && WiFi.status() != WL_CONNECTED;
       networkIndex++) {
    const WiFiCredential& network = WIFI_NETWORKS[networkIndex];
    showMessageCompact("Connecting WiFi..", network.ssid, "Please wait...");
    WiFi.disconnect();
    delay(100);
    WiFi.begin(network.ssid, network.password);

    for (int attempt = 0; attempt < 15 && WiFi.status() != WL_CONNECTED; attempt++) {
      delay(400);
    }
  }

  if (WiFi.status() == WL_CONNECTED) {
    configTime(19800, 0, "pool.ntp.org", "time.nist.gov");
    setupArduinoOta();
    showMessageCompact("WiFi Connected!", "Syncing IST Clock..", WiFi.localIP().toString().c_str());
    soundTone(1500, 150);
    delay(800);
  }
}

// ============================================================================
// TRANSMITTER WITH AUTOMATIC OFFLINE FALLBACK
// ============================================================================
bool parseSuccessResponse(const String& response, String& studentName, String& typeStr,
                          String& timeStr) {
  if (!response.startsWith("SUCCESS:")) return false;
  int inPos = response.indexOf(":IN:");
  int outPos = response.indexOf(":OUT:");
  int typePos = -1;
  String marker;
  if (inPos >= 8) {
    typePos = inPos;
    marker = "IN";
  } else if (outPos >= 8) {
    typePos = outPos;
    marker = "OUT";
  } else {
    return false;
  }
  studentName = response.substring(8, typePos);
  studentName.trim();
  typeStr = marker;
  timeStr = response.substring(typePos + marker.length() + 2);
  timeStr.trim();
  return studentName.length() > 0 && timeStr.length() > 0;
}

bool parseDuplicateResponse(const String& response, String& studentName, String& timeStr) {
  if (!response.startsWith("DUPLICATE:")) return false;
  int p1 = response.indexOf(':');
  int p2 = response.indexOf(':', p1 + 1);
  if (p1 < 0 || p2 <= p1 + 1 || p2 >= (int)response.length() - 1) return false;
  studentName = response.substring(p1 + 1, p2);
  timeStr = response.substring(p2 + 1);
  return studentName.length() > 0 && timeStr.length() > 0;
}

bool isValidatedServerResponse(const String& response) {
  if (response == "INVALID CARD" || response == "ERROR") return true;
  String studentName, typeStr, timeStr;
  if (parseSuccessResponse(response, studentName, typeStr, timeStr)) return true;
  return parseDuplicateResponse(response, studentName, timeStr);
}

int sendSingleCardHttpRequest(String uidStr, String& responseText) {
  std::unique_ptr<BearSSL::WiFiClientSecure> client(new BearSSL::WiFiClientSecure);
  client->setInsecure();
  HTTPClient http;
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.setTimeout(10000);

  String fullUrl = String(ATTENDANCE_SERVER_URL) + "?uid=" + uidStr;
  Serial.println("[HTTP] Sending UID to Vercel");
  if (!http.begin(*client, fullUrl)) return -1000;

  int httpCode = http.GET();
  if (httpCode == HTTP_CODE_OK) {
    responseText = http.getString();
    responseText.trim();
  }
  http.end();
  return httpCode;
}

void flushOfflineQueue() {
  if (queueCount == 0 || WiFi.status() != WL_CONNECTED || isOtaUpdating) return;

  Serial.println("[QUEUE] Flushing " + String(queueCount) + " offline cards to cloud...");
  int synced = 0;

  for (int i = 0; i < queueCount; i++) {
    String resp = "";
    int httpCode = sendSingleCardHttpRequest(offlineQueue[i].uid, resp);
    if (httpCode == HTTP_CODE_OK && isValidatedServerResponse(resp)) {
      synced++;
      delay(200);
    } else {
      break;
    }
  }

  if (synced > 0) {
    for (int i = synced; i < queueCount; i++) {
      offlineQueue[i - synced] = offlineQueue[i];
    }
    queueCount -= synced;
    Serial.println("[QUEUE] Synced " + String(synced) + " cards! Remaining: " + String(queueCount));
    String sMsg = "Synced " + String(synced) + " Cards!";
    showMessageCompact("Cloud Synced [OK]", sMsg.c_str(), "Telegram Updated");
    delay(1500);
    renderReadyScreen();
  }
}

void sendAttendanceToGoogleSheets(String uidStr) {
  if (isOtaUpdating) return;

  if (WiFi.status() != WL_CONNECTED) {
    connectToWiFi();
  }

  if (WiFi.status() != WL_CONNECTED) {
    enqueueOfflineScan(uidStr);
    showMessageCompact("Saved Offline [OK]", "Card Queued", "Will sync on WiFi");
    playSoundSuccess();
    delay(2000);
    renderReadyScreen();
    return;
  }

  String uidMsg = "UID: " + uidStr;
  showMessageCompact("Processing Card...", uidMsg.c_str(), "Contacting Server...");

  String responseText = "";
  int httpCode = sendSingleCardHttpRequest(uidStr, responseText);

  if (httpCode != HTTP_CODE_OK) {
    Serial.println("[HTTP] Attendance not confirmed. Code: " + String(httpCode));
    showMessageCompact("NOT CONFIRMED", "Server unavailable", "Check Sheet / Retry");
    playSoundInvalidCard();
    delay(2500);
    renderReadyScreen();
    return;
  }

  Serial.println("[HTTP] Server Response: " + responseText);

  String studentName, typeStr, timeStr;
  if (parseSuccessResponse(responseText, studentName, typeStr, timeStr)) {
    String greeting = "Hi " + sanitizeAscii(studentName);
    String bottomMsg =
        (typeStr == "OUT") ? ("Departure: " + timeStr) : ("Arrival: " + timeStr);

    showMessageCompact("SUCCESS [OK]", greeting.c_str(), bottomMsg.c_str());
    playSoundSuccess();
    delay(2500);
    renderReadyScreen();
  } else {
    String prevTimeStr;
    if (parseDuplicateResponse(responseText, studentName, prevTimeStr)) {
      String cleanName = sanitizeAscii(studentName);
      String bottomMsg = "Scanned at " + prevTimeStr;
      showMessageCompact("DUPLICATE SCAN", cleanName.c_str(), bottomMsg.c_str());
      playSoundDuplicate();
      delay(2500);
      renderReadyScreen();
    } else if (responseText == "INVALID CARD") {
      showMessageCompact("NEW CARD", "Get it registered", "Sent to Admin Phone");
      playSoundInvalidCard();
      delay(2500);
      renderReadyScreen();
    } else {
      Serial.println("[HTTP] Rejected malformed response; attendance not confirmed.");
      showMessageCompact("SERVER ERROR", "Invalid response", "Not confirmed");
      playSoundInvalidCard();
      delay(2500);
      renderReadyScreen();
    }
  }
}

// ============================================================================
// SETUP & LOOP
// ============================================================================
void setup() {
  system_update_cpu_freq(160);
  Serial.begin(115200);
  delay(100);
  bool wokeFromDeepSleep = ESP.getResetReason() == "Deep-Sleep Wake";
  Serial.println();
  Serial.println("================================");
  Serial.println(String("[BOOT] Firmware: ") + FIRMWARE_VERSION);
  Serial.println(String("[BOOT] Endpoint: ") + ATTENDANCE_SERVER_URL);
  Serial.println(String("[BOOT] Auto sleep: ") +
                   (DISABLE_AUTO_SLEEP ? "DISABLED (test)" : "ENABLED (3:30 PM-7:30 AM)"));
  Serial.println(String("[BOOT] Reset reason: ") + ESP.getResetReason());
  Serial.println("================================");

  pinMode(BUZZER_PIN, OUTPUT);
  silenceBuzzer();

  pinMode(LED_RED_PIN, OUTPUT);
  pinMode(LED_GREEN_PIN, OUTPUT);
  digitalWrite(LED_RED_PIN, LOW);
  digitalWrite(LED_GREEN_PIN, LOW);
  pinMode(BATTERY_PIN, INPUT);

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(50000);

  if (display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS)) {
    display.clearDisplay();
    display.cp437(true);
    if (!wokeFromDeepSleep) playWelcomeBootAnimation();
  }

  pn532WakeupOnce();
  pn532InitSAM();

  connectToWiFi();
#if !DISABLE_AUTO_SLEEP
  checkOvernightSchedule();
#endif
  renderReadyScreen();
}

void loop() {
  if (otaInitialized) ArduinoOTA.handle();

  if (WiFi.status() != WL_CONNECTED) {
    connectToWiFi();
  }

  if (queueCount > 0 && WiFi.status() == WL_CONNECTED &&
      (millis() - lastQueueFlush > 15000)) {
    lastQueueFlush = millis();
    flushOfflineQueue();
  }

#if !DISABLE_AUTO_SLEEP
  if (millis() - lastTimeCheck > 60000) {
    lastTimeCheck = millis();
    checkOvernightSchedule();
  }
#endif

  String uidStr = pn532ReadPassiveCard();
  if (uidStr.length() > 0) {
    unsigned long now = millis();
    if (now - lastScanTime < SCAN_DEBOUNCE_MS) {
      delay(100);
      return;
    }
    lastScanTime = now;
    sendAttendanceToGoogleSheets(uidStr);
  }

  delay(50);
}
