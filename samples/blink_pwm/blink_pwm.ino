// E-IDE Arduino Sample: Blink + Sine Wave PWM
// Generates a smooth sine wave and streams serial numeric data at 115200 baud
// for the E-IDE Serial Monitor & Plotter webview.

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  static float angle = 0.0f;
  float sineVal = sin(angle);
  float cosineVal = cos(angle);

  // Print comma-separated numeric values for live multi-channel plotting
  Serial.print(sineVal, 3);
  Serial.print(",");
  Serial.println(cosineVal, 3);

  // Map sine wave to LED PWM brightness (0 - 255)
  int brightness = (int)((sineVal + 1.0f) * 127.5f);
  analogWrite(LED_BUILTIN, brightness);

  angle += 0.08f;
  if (angle >= 6.2831853f) {
    angle = 0.0f;
  }

  delay(20);
}
