package com.example.lensmind.ai;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.Map;

/** Same-origin proxy to a fixed loopback ASR service. Never uses API keys or LiveCallBudget. */
@RestController
@RequestMapping("/api/ai/local-asr")
class LocalAsrController {
    static final String ATTRIBUTE = LocalAsrController.class.getName() + ".connection";
    private final ObjectMapper mapper;
    private final URI base;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1))
            .followRedirects(HttpClient.Redirect.NEVER).build();

    LocalAsrController(ObjectMapper mapper, @Value("${lensmind.local-asr.port:8766}") int port) {
        if (port < 1 || port > 65535) throw new IllegalArgumentException("Invalid local ASR port");
        this.mapper = mapper; base = URI.create("http://127.0.0.1:" + port);
    }

    @GetMapping("/status") ResponseEntity<?> status(HttpServletRequest request) {
        AiController.requireLocal(request);
        return success(send("/health", "GET", null, "application/json"));
    }

    @PostMapping(value = "/session", consumes = "application/json")
    ResponseEntity<?> create(@RequestBody JsonNode input, HttpServletRequest request) {
        AiController.requireLocal(request);
        if (input == null || input.path("sampleRate").asInt(0) != 16000) throw AiException.badInput("本地 ASR 需要 16kHz PCM。");
        JsonNode result = send("/sessions", "POST", mapper.writeValueAsBytes(Map.of("sampleRate", 16000)), "application/json");
        String id = result.path("id").asString("");
        if (!id.matches("[a-fA-F0-9-]{36}")) throw AiException.badOutput();
        var session = request.getSession();
        synchronized (session) {
            String old = (String) session.getAttribute(ATTRIBUTE);
            if (old != null) try { send("/sessions/" + old, "DELETE", null, "application/json"); } catch (AiException ignored) {}
            session.setAttribute(ATTRIBUTE, id);
        }
        return success(result);
    }

    @PostMapping(value = "/audio", consumes = "application/octet-stream")
    ResponseEntity<?> audio(@RequestParam String connectionId, HttpServletRequest request) throws IOException {
        require(request, connectionId);
        if (request.getContentLengthLong() > 32768) throw AiException.badInput("本地音频块过大。");
        byte[] audio = request.getInputStream().readNBytes(32769);
        if (audio.length == 0 || audio.length > 32768 || audio.length % 4 != 0) throw AiException.badInput("音频块应为 float32 PCM，最多 32768 字节。");
        JsonNode result = send("/sessions/" + connectionId + "/audio", "POST", audio, "application/octet-stream");
        require(request, connectionId);
        return success(result);
    }

    @PostMapping(value = "/reset", consumes = "application/json")
    ResponseEntity<?> reset(@RequestParam String connectionId, HttpServletRequest request) {
        require(request, connectionId);
        return success(send("/sessions/" + connectionId + "/reset", "POST", new byte[]{'{', '}'}, "application/json"));
    }

    @DeleteMapping("/session") ResponseEntity<?> close(@RequestParam String connectionId, HttpServletRequest request) {
        AiController.requireLocal(request);
        var session = request.getSession(false);
        if (session != null) synchronized (session) {
            if (connectionId.equals(session.getAttribute(ATTRIBUTE))) {
                session.removeAttribute(ATTRIBUTE);
                try { send("/sessions/" + connectionId, "DELETE", null, "application/json"); } catch (AiException ignored) {}
            }
        }
        return success(Map.of("closed", true));
    }

    private void require(HttpServletRequest request, String id) {
        AiController.requireLocal(request);
        var session = request.getSession(false);
        if (session == null || id == null || !id.equals(session.getAttribute(ATTRIBUTE))) throw new AiException(409, "本地 ASR 会话已变化，请重新开启麦克风。");
    }

    private JsonNode send(String path, String method, byte[] body, String type) {
        var request = HttpRequest.newBuilder(base.resolve(path)).timeout(Duration.ofSeconds(5))
                .header("Content-Type", type).method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(body)).build();
        try {
            var response = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
            try (var stream = response.body()) {
                if (response.statusCode() != 200) throw new AiException(response.statusCode() == 409 ? 409 : 503,
                        response.statusCode() == 409 ? "本地 ASR 会话已过期，请重新开启麦克风。" : "本地 ASR 服务拒绝音频，请检查格式和服务状态。");
                byte[] bytes = stream.readNBytes(65537);
                if (bytes.length > 65536) throw AiException.badOutput();
                return mapper.readTree(bytes);
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt(); throw new AiException(503, "本地 ASR 请求已停止。");
        } catch (IOException error) {
            throw new AiException(503, "本地 ASR 未启动或响应超时，请先启动 asr/local_asr_server.py；不会自动切换云端。");
        }
    }

    private ResponseEntity<?> success(Object body) { return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body); }
    @ExceptionHandler(AiException.class) ResponseEntity<?> error(AiException error) {
        return ResponseEntity.status(error.status()).cacheControl(CacheControl.noStore()).body(Map.of("message", error.getMessage()));
    }
}
