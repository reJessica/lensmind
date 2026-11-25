package com.example.lensmind.ai;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@ConfigurationProperties("lensmind.ai")
public record AiProperties(Mode mode, int maxLiveCalls, int timeoutSeconds,
                           Endpoint chat, Endpoint asr, Endpoint tts,
                           String asrProtocol, String ttsProtocol, String voice, boolean thinking, boolean jsonMode) {
    public enum Mode { MOCK, LIVE }
    public record Endpoint(String url, String model, String apiKey) {
        public boolean configured() {
            return url != null && !url.isBlank() && model != null && !model.isBlank()
                    && apiKey != null && !apiKey.isBlank();
        }
        @Override public String toString() { return "Endpoint[model=" + model + ", apiKey=REDACTED]"; }
    }
}

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(AiProperties.class)
class AiConfiguration {}
