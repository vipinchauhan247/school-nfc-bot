/**
 * Copy to your Arduino sketch folder as private_config.h
 * Edit Wi-Fi names/passwords and OTA password before flashing.
 */
#pragma once

struct WiFiCredential {
  const char* ssid;
  const char* password;
};

static const WiFiCredential WIFI_NETWORKS[] = {
  {"YOUR_WIFI_NAME", "YOUR_WIFI_PASSWORD"},
  // {"School_WiFi_2", "password2"},
};

static const size_t WIFI_NETWORK_COUNT =
    sizeof(WIFI_NETWORKS) / sizeof(WIFI_NETWORKS[0]);

#define OTA_PASSWORD "change-this-ota-password"
