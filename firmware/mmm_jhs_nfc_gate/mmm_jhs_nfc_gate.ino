/**
 * MMM JHS — ESP8266 NFC Gate Attendance
 * Board: NodeMCU / Wemos D1 mini
 * NFC:  PN532 (I2C)
 * OLED: SSD1306 128x64 (I2C, address 0x3C)
 *
 * Server: @Vipinbellbot on Render — GET /nfc?uid=XXXX
 * Response (plain text):
 *   SUCCESS:Name:IN:HH:mm:ss
 *   SUCCESS:Name:OUT:HH:mm:ss
 *   DUPLICATE:Name:HH:mm:ss
 *   INVALID CARD
 *   ERROR
 *
 * Arduino IDE:
 *   Board:     NodeMCU 1.0 (ESP-12E Module)
 *   Flash:     4MB (FS:none, OTA disabled) or as your module supports
 *   Libraries: Adafruit PN532, Adafruit SSD1306, Adafruit GFX Library
 *
 * Wiring (I2C — SDA=D2/GPIO4, SCL=D1/GPIO5):
 *   PN532  VCC→3V3  GND→GND  SDA→D2  SCL→D1
 *   OLED   VCC→3V3  GND→GND  SDA→D2  SCL→D1
 */

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_PN532.h>

// ─── EDIT THESE BEFORE FLASHING ─────────────────────────────────────────────
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// @Vipinbellbot Render URL (no trailing slash)
const char* SERVER_BASE   = "https://school-nfc-bot.onrender.com";

// Optional: call /warm on boot so first morning tap is fast
const bool WARM_ON_BOOT   = true;
// ────────────────────────────────────────────────────────────────────────────

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET    -1
#define OLED_ADDR     0x3C

#define I2C_SDA D2  // GPIO4
#define I2C_SCL D1  // GPIO5

static const int PN532_IRQ   = -1;  // I2C mode — not wired
static const int PN532_RESET = -1;

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
Adafruit_PN532 nfc(PN532_IRQ, PN532_RESET);

const unsigned long SAME_CARD_MS   = 4000;   // ignore same UID within 4s
const unsigned long WIFI_RETRY_MS  = 15000;
const unsigned long HTTP_TIMEOUT_MS = 8000;

String lastUid = "";
unsigned long lastUidAt = 0;
bool wifiOk = false;

void showLines(const char* line1, const char* line2 = "", const char* line3 = "") {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println(line1);
  if (line2[0]) display.println(line2);
  if (line3[0]) display.println(line3);
  display.display();
}

void showBig(const char* line1, const char* line2 = "") {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(2);
  display.setCursor(0, 0);
  display.println(line1);
  if (line2[0]) {
    display.setTextSize(1);
    display.setCursor(0, 36);
    display.println(line2);
  }
  display.display();
}

String uidToString(uint8_t* uid, uint8_t uidLength) {
  String out = "";
  for (uint8_t i = 0; i < uidLength; i++) {
    if (uid[i] < 0x10) out += "0";
    out += String(uid[i], HEX);
  }
  out.toUpperCase();
  return out;
}

bool connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    wifiOk = true;
    return true;
  }
  wifiOk = false;
  showLines("WiFi...", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(250);
    ESP.wdtFeed();
  }

  if (WiFi.status() == WL_CONNECTED) {
    wifiOk = true;
    showLines("WiFi OK", WiFi.localIP().toString().c_str(), "Tap card");
    delay(800);
    return true;
  }

  showLines("WiFi FAILED", "Check SSID/PWD", "Retrying...");
  return false;
}

String httpGet(const String& url) {
  WiFiClientSecure client;
  client.setInsecure();  // Render uses valid HTTPS; skip cert store on ESP8266
  client.setTimeout(HTTP_TIMEOUT_MS / 1000);

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);

  if (!http.begin(client, url)) {
    return String("__HTTP_BEGIN_FAIL__");
  }

  int code = http.GET();
  String body = http.getString();
  http.end();

  if (code <= 0) {
    return String("__HTTP_ERR__") + String(code);
  }
  if (code != 200) {
    return String("__HTTP_") + String(code) + "__";
  }
  body.trim();
  return body;
}

void warmServerCache() {
  if (!wifiOk) return;
  String url = String(SERVER_BASE) + "/warm";
  showLines("Warming...", "Please wait");
  httpGet(url);
  showLines("Ready", "Tap NFC card");
  delay(600);
}

void parseAndShow(const String& resp) {
  if (resp.startsWith("__HTTP")) {
    showLines("Network error", resp.c_str(), "Tap again");
    return;
  }

  if (resp == "ERROR") {
    showLines("Server busy", "Try again", "in 2 sec");
    return;
  }

  if (resp == "INVALID CARD") {
    showBig("INVALID", "CARD");
    return;
  }

  // SUCCESS:Name:IN:HH:mm:ss  or  SUCCESS:Name:OUT:HH:mm:ss
  if (resp.startsWith("SUCCESS:")) {
    int p1 = resp.indexOf(':', 8);
    int p2 = resp.indexOf(':', p1 + 1);
    if (p1 > 0 && p2 > p1) {
      String name = resp.substring(8, p1);
      String inOut = resp.substring(p1 + 1, p2);
      String timeStr = resp.substring(p2 + 1);
      if (name.length() > 14) name = name.substring(0, 14);
      showBig(inOut.c_str(), name.c_str());
      display.setTextSize(1);
      display.setCursor(0, 56);
      display.println(timeStr);
      display.display();
      return;
    }
  }

  // DUPLICATE:Name:HH:mm:ss
  if (resp.startsWith("DUPLICATE:")) {
    int p1 = resp.indexOf(':', 10);
    String name = (p1 > 0) ? resp.substring(10, p1) : resp.substring(10);
    String timeStr = (p1 > 0) ? resp.substring(p1 + 1) : "";
    if (name.length() > 14) name = name.substring(0, 14);
    showLines("DUPLICATE", name.c_str(), timeStr.c_str());
    return;
  }

  showLines("Unknown reply", resp.substring(0, 20).c_str());
}

void handleCardTap(const String& uid) {
  unsigned long now = millis();
  if (uid == lastUid && (now - lastUidAt) < SAME_CARD_MS) {
    showLines("Wait...", "Same card");
    return;
  }
  lastUid = uid;
  lastUidAt = now;

  if (!connectWiFi()) return;

  showLines("Reading...", uid.c_str());

  String url = String(SERVER_BASE) + "/nfc?uid=" + uid;
  String resp = httpGet(url);
  parseAndShow(resp);

  // Return to idle after 3 seconds
  delay(3000);
  showLines("MMM JHS Gate", "Tap NFC card");
}

void setup() {
  Serial.begin(115200);
  Serial.println();
  Serial.println(F("MMM JHS NFC Gate starting..."));

  Wire.begin(I2C_SDA, I2C_SCL);

  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println(F("SSD1306 init failed"));
    for (;;) delay(1000);
  }

  showLines("MMM JHS", "NFC Gate", "Starting...");

  nfc.begin();
  uint32_t version = nfc.getFirmwareVersion();
  if (!version) {
    showLines("PN532 ERROR", "Check I2C wiring", "SDA=D2 SCL=D1");
    for (;;) delay(1000);
  }

  nfc.SAMConfig();
  Serial.print(F("PN532 firmware: 0x"));
  Serial.println(version, HEX);

  connectWiFi();

  if (WARM_ON_BOOT && wifiOk) {
    warmServerCache();
  } else {
    showLines("MMM JHS Gate", "Tap NFC card");
  }
}

void loop() {
  static unsigned long lastWifiCheck = 0;

  if (millis() - lastWifiCheck > WIFI_RETRY_MS) {
    lastWifiCheck = millis();
    if (WiFi.status() != WL_CONNECTED) {
      wifiOk = false;
      connectWiFi();
    }
  }

  uint8_t uid[7];
  uint8_t uidLength;

  if (!nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLength, 120)) {
    return;
  }

  if (uidLength == 0) return;

  String uidStr = uidToString(uid, uidLength);
  Serial.print(F("Card UID: "));
  Serial.println(uidStr);

  handleCardTap(uidStr);

  // Wait for card removal
  delay(500);
  while (nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLength, 50)) {
    delay(100);
  }
}
