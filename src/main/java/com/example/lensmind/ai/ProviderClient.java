package com.example.lensmind.ai;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** 明确的完整 endpoint URL，不自动拼接服务商路径；无自动重试、无授权重定向。 */
@Component
public class ProviderClient {
    private final AiProperties properties;
    private final ObjectMapper mapper;
    private final HttpClient http;
    public ProviderClient(AiProperties properties, ObjectMapper mapper) {
        this.properties = properties;
        this.mapper = mapper;
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5))
                .followRedirects(HttpClient.Redirect.NEVER).build();
    }
    public void require(AiProperties.Endpoint endpoint) {
        if (!endpoint.configured()) throw new AiException(HttpStatus.SERVICE_UNAVAILABLE,
                "MODEL_NOT_CONFIGURED", "请在本机配置对应模型的完整 URL、模型 ID 和 API Key");
        URI uri;
        try { uri = URI.create(endpoint.url()); } catch (Exception e) { throw AiException.badInput("模型 URL 配置无效"); }
        boolean local = "127.0.0.1".equals(uri.getHost()) || "localhost".equals(uri.getHost());
        if (uri.getUserInfo() != null || uri.getHost() == null || uri.getFragment() != null
                || !("https".equals(uri.getScheme()) || local && "http".equals(uri.getScheme()))) {
            throw AiException.badInput("模型 URL 必须使用 HTTPS（本机开发可用 HTTP），且不能包含账号或片段");
        }
    }
    public JsonNode json(AiProperties.Endpoint endpoint, Map<String, Object> payload) {
        byte[] result = post(endpoint, payload, "application/json", 2_000_000).bytes();
        try { return mapper.readTree(result); } catch (Exception e) { throw AiException.badOutput(); }
    }
    public Reply post(AiProperties.Endpoint endpoint, Map<String, Object> payload, String accept, int maxBytes) {
        require(endpoint);
        HttpRequest request = HttpRequest.newBuilder(URI.create(endpoint.url()))
                .timeout(Duration.ofSeconds(Math.max(1, Math.min(60, properties.timeoutSeconds()))))
                .header("Authorization", "Bearer " + endpoint.apiKey())
                .header("Content-Type", "application/json").header("Accept", accept)
                .POST(HttpRequest.BodyPublishers.ofByteArray(mapper.writeValueAsBytes(payload))).build();
        return send(request, maxBytes);
    }
    public byte[] geminiSpeech(AiProperties.Endpoint endpoint, String text, double rate) {
        require(endpoint);
        var payload = Map.of("contents", List.of(Map.of("parts", List.of(Map.of("text", text,
                "speech_metadata", Map.of("style", rate < 1 ? "Speak slowly in Mandarin Chinese." : rate > 1 ? "Speak briskly in Mandarin Chinese." : "Speak naturally in Mandarin Chinese."))))),
                "generationConfig", Map.of("responseModalities", List.of("AUDIO"), "speechConfig",
                        Map.of("voiceConfig", Map.of("prebuiltVoiceConfig", Map.of("voiceName", "Kore")))));
        var request = HttpRequest.newBuilder(URI.create(endpoint.url()))
                .timeout(Duration.ofSeconds(Math.max(1, Math.min(60, properties.timeoutSeconds()))))
                .header("x-goog-api-key", endpoint.apiKey()).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(mapper.writeValueAsBytes(payload))).build();
        return geminiWav(send(request, 12_000_000).bytes());
    }
    byte[] geminiWav(byte[] json) {
        try {
            var parts = mapper.readTree(json).path("candidates").path(0).path("content").path("parts");
            for (var part : parts) {
                var inline = part.path("inlineData");
                if (inline.isMissingNode()) inline = part.path("inline_data");
                String mime = inline.path("mimeType").asString(inline.path("mime_type").asString(""));
                if (!"audio/wav".equalsIgnoreCase(mime)) continue;
                byte[] audio = java.util.Base64.getDecoder().decode(inline.path("data").asString(""));
                if (audio.length > 8_000_000 || !"audio/wav".equals(SpeechController.audioType(audio))) throw AiException.badOutput();
                return audio;
            }
        } catch (Exception ignored) { throw AiException.badOutput(); }
        throw new AiException(502, "Gemini 未返回有效 WAV 音频，请检查模型通道。");
    }
    public JsonNode transcribeMultipart(AiProperties.Endpoint endpoint, byte[] wav) {
        require(endpoint);
        String boundary = "LensMind" + UUID.randomUUID().toString().replace("-", "");
        String prefix = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n" + endpoint.model()
                + "\r\n--" + boundary + "\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\nzh"
                + "\r\n--" + boundary + "\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\njson"
                + "\r\n--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"recording.wav\"\r\nContent-Type: audio/wav\r\n\r\n";
        var body = HttpRequest.BodyPublishers.ofByteArrays(List.of(prefix.getBytes(StandardCharsets.UTF_8), wav,
                ("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8)));
        HttpRequest request = HttpRequest.newBuilder(URI.create(endpoint.url()))
                .timeout(Duration.ofSeconds(Math.max(1, Math.min(60, properties.timeoutSeconds()))))
                .header("Authorization", "Bearer " + endpoint.apiKey())
                .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .header("Accept", "application/json").POST(body).build();
        byte[] result = send(request, 2_000_000).bytes();
        try { return mapper.readTree(result); } catch (Exception e) { throw AiException.badOutput(); }
    }
    public Reply audioDownload(String address) {
        // DashScope 非流式 TTS 返回 OSS 临时 URL。只下载白名单 HTTPS，不附带模型 Key。
        URI uri;
        try { uri = URI.create(address); } catch (Exception e) { throw AiException.badOutput(); }
        String host = uri.getHost();
        if (host == null || !host.endsWith(".aliyuncs.com") || uri.getUserInfo() != null
                || uri.getPort() != -1 || uri.getFragment() != null
                || !("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()))) throw AiException.badOutput();
        URI secure = URI.create(address.replaceFirst("^http:", "https:"));
        return send(HttpRequest.newBuilder(secure).timeout(Duration.ofSeconds(20)).GET().build(), 8_000_000);
    }
    private Reply send(HttpRequest request, int maxBytes) {
        try {
            HttpResponse<InputStream> response = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
            try (InputStream stream = response.body()) {
                if (response.statusCode() < 200 || response.statusCode() >= 300) {
                    // 不向客户端转发供应商响应体，避免泄漏 Key、音频、图片和签名 URL。
                    if (response.statusCode() == 429) {
                        String error = new String(stream.readNBytes(8192), StandardCharsets.UTF_8).toLowerCase(java.util.Locale.ROOT);
                        if (error.contains("负载已饱和") || error.contains("overloaded") || error.contains("saturated")) {
                            throw new AiException(HttpStatus.SERVICE_UNAVAILABLE, "PROVIDER_BUSY", "模型供应商上游负载已饱和，请稍后手动重试；未自动重试");
                        }
                        if (error.contains("insufficient_quota") || error.contains("余额不足") || error.contains("额度不足") || error.contains("insufficient balance")) {
                            throw new AiException(HttpStatus.SERVICE_UNAVAILABLE, "PROVIDER_QUOTA_EXHAUSTED", "模型供应商提示额度或余额不足，请检查账号；未自动重试");
                        }
                        throw new AiException(HttpStatus.SERVICE_UNAVAILABLE, "PROVIDER_RATE_LIMITED", "模型供应商返回限流，请稍后手动重试；未自动重试");
                    }
                    throw new AiException(HttpStatus.BAD_GATEWAY, "PROVIDER_HTTP_" + response.statusCode(),
                            "模型供应商返回 HTTP " + response.statusCode() + "，请检查账号权限、模型 ID、接口地址和额度");
                }
                byte[] bytes = stream.readNBytes(maxBytes + 1);
                if (bytes.length > maxBytes) throw new AiException(HttpStatus.BAD_GATEWAY, "PROVIDER_RESPONSE_TOO_LARGE", "模型响应超过大小限制");
                return new Reply(bytes, response.headers().firstValue("Content-Type").orElse("application/octet-stream"));
            }
        } catch (HttpTimeoutException e) {
            throw new AiException(HttpStatus.GATEWAY_TIMEOUT, "PROVIDER_TIMEOUT", "模型调用超时，未自动重试");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AiException(HttpStatus.SERVICE_UNAVAILABLE, "PROVIDER_INTERRUPTED", "模型调用已中断");
        } catch (IOException e) {
            throw new AiException(HttpStatus.BAD_GATEWAY, "PROVIDER_UNREACHABLE", "无法连接模型服务，请检查网络或代理设置");
        }
    }
    public String content(JsonNode response) {
        JsonNode content = response.path("choices").path(0).path("message").path("content");
        if (!content.isString() || content.asString().isBlank() || content.asString().length() > 16000) throw AiException.badOutput();
        return content.asString();
    }
    public <T> T structured(String content, Class<T> type) {
        String text = content.trim();
        if (text.startsWith("```json") && text.endsWith("```")) text = text.substring(7, text.length() - 3).trim();
        else if (text.startsWith("```") && text.endsWith("```")) text = text.substring(3, text.length() - 3).trim();
        try { return mapper.readValue(text, type); } catch (Exception e) { throw AiException.badOutput(); }
    }
    public record Reply(byte[] bytes, String contentType) {}
}
