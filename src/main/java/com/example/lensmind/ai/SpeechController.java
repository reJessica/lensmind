package com.example.lensmind.ai;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import java.io.IOException;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/** 摄影工作台的独立语音会话。只接受固定模型，不接收任意上游 URL。 */
@RestController
@RequestMapping("/api/ai/speech")
class SpeechController {
    static final String ASR = "fun-asr-realtime-2026-02-28";
    static final String TTS = "qwen-audio-3.1-tts-flash";
    static final String VOICE = "longanhuan_v3.1";
    private static final String ATTRIBUTE = SpeechController.class.getName() + ".session";
    private final DashScopeSpeechClient client;
    SpeechController(DashScopeSpeechClient client) { this.client = client; }

    static final class Connection {
        final String id = UUID.randomUUID().toString();
        final Instant expiresAt = Instant.now().plusSeconds(1800);
        final String asr, tts, workspace;
        private final String key;
        Connection(String asr, String tts, String workspace, String key) {
            this.asr = asr; this.tts = tts; this.workspace = workspace; this.key = key;
        }
        String key() { return key; }
        @Override public String toString() { return "SpeechConnection[credentials=REDACTED]"; }
    }
    record Configure(String asr, String tts, String workspace, String apiKey) {
        @Override public String toString() { return "SpeechConfigure[credentials=REDACTED]"; }
    }
    record Synthesis(String connectionId, String text, double rate) {}

    @GetMapping("/session") ResponseEntity<?> status(HttpServletRequest request) {
        AiController.requireLocal(request);
        return success(describe(current(request)));
    }
    @PostMapping("/session") ResponseEntity<?> configure(@RequestBody Configure input, HttpServletRequest request) {
        AiController.requireLocal(request);
        if (input == null || !("browser".equals(input.asr()) || ASR.equals(input.asr()))
                || !("browser".equals(input.tts()) || TTS.equals(input.tts()))) throw AiException.badInput("请选择预设的 ASR 和 TTS 模型。");
        if ("browser".equals(input.asr()) && "browser".equals(input.tts())) return disconnect(request);
        String workspace = input.workspace() == null ? "" : input.workspace().strip();
        String key = input.apiKey() == null ? "" : input.apiKey().strip();
        Connection previous = current(request);
        if (key.isEmpty() && previous != null && workspace.equals(previous.workspace)) key = previous.key();
        if (!key.matches("[!-~]{1,2048}")) throw AiException.badInput("请填写阿里云百炼北京地域的独立 API Key。");
        if (!workspace.matches("[a-zA-Z0-9][a-zA-Z0-9-]{0,79}")) throw AiException.badInput("请填写北京地域 Workspace ID（字母、数字或连字符）。");
        var connection = new Connection(input.asr(), input.tts(), workspace, key);
        var session = request.getSession();
        session.setMaxInactiveInterval(1800);
        synchronized (session) { session.setAttribute(ATTRIBUTE, connection); }
        return success(describe(connection));
    }
    @DeleteMapping("/session") ResponseEntity<?> disconnect(HttpServletRequest request) {
        AiController.requireLocal(request);
        var session = request.getSession(false);
        if (session != null) session.removeAttribute(ATTRIBUTE);
        return success(describe(null));
    }
    @PostMapping(value = "/asr", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    ResponseEntity<?> transcribe(@RequestParam String connectionId, @RequestPart("audio") MultipartFile audio,
                                HttpServletRequest request) throws IOException {
        Connection connection = require(request, connectionId);
        if (!ASR.equals(connection.asr)) throw AiException.badInput("当前会话未启用云端 ASR。");
        if (audio.isEmpty() || audio.getSize() > 500_000) throw AiException.badInput("录音必须为不超过 15 秒的 16kHz 单声道 WAV。");
        String text = client.transcribe(connection, audio.getBytes());
        require(request, connectionId);
        return success(Map.of("text", text, "model", ASR, "mode", "LIVE"));
    }
    @PostMapping("/tts") ResponseEntity<byte[]> synthesize(@RequestBody Synthesis input, HttpServletRequest request) {
        Connection connection = require(request, input == null ? null : input.connectionId());
        if (!TTS.equals(connection.tts)) throw AiException.badInput("当前会话未启用云端 TTS。");
        String text = CommandPolicy.text(input.text(), 160, "text");
        if (!Double.isFinite(input.rate()) || input.rate() < .8 || input.rate() > 1.2) throw AiException.badInput("播报语速必须在 0.8～1.2 之间。");
        byte[] audio = client.synthesize(connection, text, input.rate());
        require(request, input.connectionId());
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(MediaType.valueOf("audio/mpeg"))
                .header("X-LensMind-Mode", "LIVE").header("X-LensMind-Audio", "speech").body(audio);
    }
    private Connection require(HttpServletRequest request, String id) {
        AiController.requireLocal(request);
        Connection connection = current(request);
        if (connection == null || !connection.id.equals(id)) throw new AiException(409, "语音配置未保存、已过期或已变更，请到设置页重新保存。");
        return connection;
    }
    private Connection current(HttpServletRequest request) {
        var session = request.getSession(false);
        if (session == null) return null;
        try {
            synchronized (session) {
                Connection connection = (Connection) session.getAttribute(ATTRIBUTE);
                if (connection != null && !Instant.now().isBefore(connection.expiresAt)) {
                    session.removeAttribute(ATTRIBUTE); return null;
                }
                return connection;
            }
        } catch (IllegalStateException expired) { return null; }
    }
    private Map<String, Object> describe(Connection connection) {
        if (connection == null) return Map.of("configured", false);
        return Map.of("configured", true, "id", connection.id, "asr", connection.asr, "tts", connection.tts,
                "voice", VOICE, "workspace", connection.workspace, "expiresAt", connection.expiresAt,
                "verified", false, "notice", "仅保存本机会话，尚未验证供应商鉴权或模型权限。");
    }
    private ResponseEntity<?> success(Object body) { return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body); }
    @ExceptionHandler(AiException.class) ResponseEntity<?> error(AiException error) {
        return ResponseEntity.status(error.status()).cacheControl(CacheControl.noStore()).body(Map.of("message", error.getMessage()));
    }
}
