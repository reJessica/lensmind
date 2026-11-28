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
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;

/** 摄影工作台的独立语音会话。只接受固定模型，不接收任意上游 URL。 */
@RestController
@RequestMapping("/api/ai/speech")
class SpeechController {
    static final String ASR = "fun-asr-realtime-2026-02-28";
    static final String TTS = "qwen-audio-3.1-tts-flash";
    static final String VOICE = "longanhuan_v3.1";
    static final String UNI_ASR = "whisper-1", UNI_TTS = "tts-1", UNI_VOICE = "alloy";
    static final String GEMINI_TTS = "gemini-3.8-flash-lite-tts";
    private static final String ATTRIBUTE = SpeechController.class.getName() + ".session";
    private final DashScopeSpeechClient client;
    private final ProviderClient relay;
    private final LiveCallBudget budget;
    private final String localUniapiKey;
    SpeechController(DashScopeSpeechClient client) { this(client, null, null, ""); }
    @Autowired
    SpeechController(DashScopeSpeechClient client, ProviderClient relay, LiveCallBudget budget,
                     @Value("${LENSMIND_UNIAPI_KEY:${lensmind.uniapi-key:}}") String localUniapiKey) {
        this.client = client; this.relay = relay; this.budget = budget; this.localUniapiKey = localUniapiKey.strip();
    }

    static final class Connection {
        final String id = UUID.randomUUID().toString();
        final Instant expiresAt = Instant.now().plusSeconds(1800);
        final String asr, tts, workspace, provider;
        private final String key;
        Connection(String asr, String tts, String workspace, String key) {
            this(asr, tts, workspace, key, "dashscope");
        }
        Connection(String asr, String tts, String workspace, String key, String provider) {
            this.asr = asr; this.tts = tts; this.workspace = workspace; this.key = key; this.provider = provider;
        }
        String key() { return key; }
        @Override public String toString() { return "SpeechConnection[credentials=REDACTED]"; }
    }
    record Configure(String asr, String tts, String workspace, String apiKey, String provider) {
        Configure(String asr, String tts, String workspace, String apiKey) { this(asr, tts, workspace, apiKey, null); }
        @Override public String toString() { return "SpeechConfigure[credentials=REDACTED]"; }
    }
    record Synthesis(String connectionId, String text, double rate) {}

    @GetMapping("/session") ResponseEntity<?> status(HttpServletRequest request) {
        AiController.requireLocal(request);
        return success(describe(current(request)));
    }
    @PostMapping("/session") ResponseEntity<?> configure(@RequestBody Configure input, HttpServletRequest request) {
        AiController.requireLocal(request);
        if (input == null) throw AiException.badInput("请选择语音服务商和固定模型。");
        String provider = input.provider() == null ? (UNI_ASR.equals(input.asr()) || UNI_TTS.equals(input.tts()) || GEMINI_TTS.equals(input.tts()) ? "uniapi" : "dashscope") : input.provider();
        boolean uniapi = "uniapi".equals(provider);
        if (!(uniapi || "dashscope".equals(provider)) || !("browser".equals(input.asr()) || (uniapi ? UNI_ASR : ASR).equals(input.asr()))
                || !("browser".equals(input.tts()) || (uniapi ? UNI_TTS : TTS).equals(input.tts()) || uniapi && GEMINI_TTS.equals(input.tts()))) throw AiException.badInput("所选语音模型与服务商不匹配，请选择同一服务商的预设。");
        if ("browser".equals(input.asr()) && "browser".equals(input.tts())) return disconnect(request);
        String workspace = uniapi || input.workspace() == null ? "" : input.workspace().strip();
        String key = input.apiKey() == null ? "" : input.apiKey().strip();
        Connection previous = current(request);
        if (key.isEmpty() && previous != null && provider.equals(previous.provider) && workspace.equals(previous.workspace)) key = previous.key();
        if (key.isEmpty() && uniapi) key = localUniapiKey;
        if (!key.matches("[!-~]{1,2048}")) throw AiException.badInput(uniapi ? "请填写 UniAPI Key，或配置本机 lensmind.uniapi-key。" : "请填写阿里云百炼北京地域的独立 API Key。");
        if (!uniapi && !workspace.matches("[a-zA-Z0-9][a-zA-Z0-9-]{0,79}")) throw AiException.badInput("请填写北京地域 Workspace ID（字母、数字或连字符）。");
        var connection = new Connection(input.asr(), input.tts(), workspace, key, provider);
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
        if ("browser".equals(connection.asr)) throw AiException.badInput("当前会话未启用云端 ASR。");
        if (audio.isEmpty() || audio.getSize() > 500_000) throw AiException.badInput("录音必须为不超过 15 秒的 16kHz 单声道 WAV。");
        byte[] wav = audio.getBytes();
        String text;
        if ("uniapi".equals(connection.provider)) {
            DashScopeSpeechClient.pcm(wav);
            var response = budget.call(() -> relay.transcribeMultipart(uniapiEndpoint(connection, false), wav));
            text = response.path("text").asString("").strip();
            if (text.isEmpty() || text.length() > 500) throw new AiException(502, "UniAPI 未返回有效的短句转写。");
        } else text = client.transcribe(connection, wav);
        require(request, connectionId);
        return success(Map.of("text", text, "model", connection.asr, "mode", "LIVE"));
    }
    @PostMapping("/tts") ResponseEntity<byte[]> synthesize(@RequestBody Synthesis input, HttpServletRequest request) {
        Connection connection = require(request, input == null ? null : input.connectionId());
        if ("browser".equals(connection.tts)) throw AiException.badInput("当前会话未启用云端 TTS。");
        String text = CommandPolicy.text(input.text(), 160, "text");
        if (!Double.isFinite(input.rate()) || input.rate() < .8 || input.rate() > 1.2) throw AiException.badInput("播报语速必须在 0.8～1.2 之间。");
        byte[] audio;
        String contentType;
        if ("uniapi".equals(connection.provider)) {
            if (GEMINI_TTS.equals(connection.tts)) audio = budget.call(() -> relay.geminiSpeech(uniapiEndpoint(connection, true), text, input.rate()));
            else audio = budget.call(() -> relay.post(uniapiEndpoint(connection, true), Map.of("model", UNI_TTS, "input", text,
                    "voice", UNI_VOICE, "response_format", "wav", "speed", input.rate()), "audio/*", 8_000_000)).bytes();
            contentType = audioType(audio);
        } else { audio = client.synthesize(connection, text, input.rate()); contentType = "audio/mpeg"; }
        require(request, input.connectionId());
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(MediaType.valueOf(contentType))
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
        if (connection == null) return Map.of("configured", false, "localUniapiKeyConfigured", !localUniapiKey.isEmpty());
        return Map.of("configured", true, "id", connection.id, "asr", connection.asr, "tts", connection.tts,
                "voice", GEMINI_TTS.equals(connection.tts) ? "Kore" : "uniapi".equals(connection.provider) ? UNI_VOICE : VOICE, "provider", connection.provider, "workspace", connection.workspace, "expiresAt", connection.expiresAt,
                "verified", false, "notice", "仅保存本机会话，尚未验证供应商鉴权或模型权限。");
    }
    static AiProperties.Endpoint uniapiEndpoint(Connection connection, boolean tts) {
        if (!"uniapi".equals(connection.provider)) throw AiException.badInput("语音服务商不匹配。");
        if (tts && GEMINI_TTS.equals(connection.tts)) return new AiProperties.Endpoint("https://api.uniapi.io/gemini/v1beta/models/" + GEMINI_TTS + ":generateContent", GEMINI_TTS, connection.key());
        return new AiProperties.Endpoint("https://api.uniapi.io/v1/audio/" + (tts ? "speech" : "transcriptions"), tts ? UNI_TTS : UNI_ASR, connection.key());
    }
    static String audioType(byte[] bytes) {
        if (bytes.length >= 44 && bytes[0] == 'R' && bytes[1] == 'I' && bytes[2] == 'F' && bytes[3] == 'F'
                && bytes[8] == 'W' && bytes[9] == 'A' && bytes[10] == 'V' && bytes[11] == 'E') return "audio/wav";
        if (bytes.length >= 3 && (bytes[0] == 'I' && bytes[1] == 'D' && bytes[2] == '3'
                || (bytes[0] & 255) == 255 && (bytes[1] & 224) == 224)) return "audio/mpeg";
        throw new AiException(502, "UniAPI 未返回有效音频，请检查模型通道与服务状态。");
    }
    private ResponseEntity<?> success(Object body) { return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body); }
    @ExceptionHandler(AiException.class) ResponseEntity<?> error(AiException error) {
        return ResponseEntity.status(error.status()).cacheControl(CacheControl.noStore()).body(Map.of("message", error.getMessage()));
    }
}
