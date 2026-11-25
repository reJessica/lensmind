package com.example.lensmind.ai;

import static com.example.lensmind.ai.AiContracts.*;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;
import org.springframework.core.io.ResourceLoader;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

@Service
public class AiService {
    public static final String PROMPT_VERSION = "lensmind-v1";
    private final AiProperties properties;
    private final ProviderClient provider;
    private final LiveCallBudget budget;
    private final String commandPrompt;
    private final String visionPrompt;

    public AiService(AiProperties properties, ProviderClient provider, LiveCallBudget budget, ResourceLoader resources) throws IOException {
        this.properties = properties;
        this.provider = provider;
        this.budget = budget;
        try (var in = resources.getResource("classpath:prompts/command-v1.txt").getInputStream()) { commandPrompt = new String(in.readAllBytes(), StandardCharsets.UTF_8); }
        try (var in = resources.getResource("classpath:prompts/vision-v1.txt").getInputStream()) { visionPrompt = new String(in.readAllBytes(), StandardCharsets.UTF_8); }
    }
    private boolean live() { return properties.mode() == AiProperties.Mode.LIVE; }
    public Map<String, Object> status() {
        return Map.of("mode", properties.mode(), "promptVersion", PROMPT_VERSION,
                "liveCallAttempts", budget.used(), "maxLiveCalls", budget.limit(),
                "models", Map.of("chat", config(properties.chat()), "asr", config(properties.asr()), "tts", config(properties.tts())),
                "protocols", Map.of("asr", properties.asrProtocol(), "tts", properties.ttsProtocol()),
                "executesDeviceActions", false,
                "notice", "configured 仅表示配置齐全，不表示供应商已验证；MOCK 为固定示例，LIVE 失败不会伪装成功");
    }
    private Map<String, Object> config(AiProperties.Endpoint e) { return Map.of("model", e.model(), "configured", e.configured()); }
    private <T> Result<T> result(T data, String source, String model, String... warnings) {
        return new Result<>(UUID.randomUUID().toString(), properties.mode().name(), source, model, PROMPT_VERSION, data, List.of(warnings));
    }
    public Result<Command> command(CommandRequest request) {
        if (request == null) throw AiException.badInput("缺少指令");
        String text = CommandPolicy.normalize(CommandPolicy.text(request.text(), 300, "text"));
        Command guard = CommandPolicy.guard(text);
        if (guard != null) return result(guard, "RULE", "none", "只返回意图，不执行设备动作；STOP 请直接调用停止接口");
        if (!live()) return result(CommandPolicy.mock(text), "MOCK", "none", "规则模拟，未调用语言模型");
        provider.require(properties.chat());
        String context = "当前构图=" + request.composition() + "，当前景别=" + request.framing() + "。用户原话：" + text;
        JsonNode response = budget.call(() -> provider.json(properties.chat(), chat(commandPrompt, context)));
        Command command = CommandPolicy.validate(provider.structured(provider.content(response), Command.class), text);
        return result(command, "MODEL", properties.chat().model(), "动作仍需由页面确认流程和控制端校验；本接口不执行动作");
    }
    private Map<String, Object> chat(String system, Object content) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", properties.chat().model());
        body.put("messages", List.of(Map.of("role", "system", "content", system), Map.of("role", "user", "content", content)));
        body.put("temperature", .1);
        body.put("max_tokens", 700);
        body.put("stream", false);
        body.put("enable_thinking", properties.thinking());
        if (properties.jsonMode()) body.put("response_format", Map.of("type", "json_object"));
        return body;
    }
    public Result<FrameAnalysis> vision(byte[] bytes, String frameId, String capturedAt, Composition composition, Framing framing) {
        frameId = CommandPolicy.text(frameId, 100, "frameId");
        try { Instant.parse(capturedAt); } catch (Exception e) { throw AiException.badInput("capturedAt 必须为 ISO-8601 时间，例如 2026-11-19T08:00:00Z"); }
        if (composition == null || framing == null) throw AiException.badInput("请提供目标构图 composition 和景别 framing");
        MediaInput.Image image = MediaInput.image(bytes);
        Vision analysis;
        if (!live()) {
            analysis = new Vision(null, null, "MOCK：未检测此图片中的人物", "请接入视觉模型后判断构图", "请看向镜头，放松肩膀。（预设示例）", "UNKNOWN");
        } else {
            provider.require(properties.chat());
            Object content = List.of(Map.of("type", "text", "text", "目标构图=" + composition + "，景别=" + framing + "。请分析该原始画面。"),
                    Map.of("type", "image_url", "image_url", Map.of("url", image.dataUrl())));
            JsonNode response = budget.call(() -> provider.json(properties.chat(), chat(visionPrompt, content)));
            analysis = validateVision(provider.structured(provider.content(response), Vision.class));
        }
        return result(new FrameAnalysis(frameId, capturedAt, image.width(), image.height(), composition, framing, analysis),
                live() ? "MODEL" : "MOCK", live() ? properties.chat().model() : "none",
                "单帧不能判断稳定性；人物框为模型粗略估计，不是精确检测或关节控制依据",
                "模型不执行机位调整；使用建议前需核对帧时效并由控制端校验");
    }
    static Vision validateVision(Vision v) {
        if (v == null || !valid(v.assessment(), 300) || !valid(v.suggestion(), 200) || !valid(v.guidance(), 100)) throw AiException.badOutput();
        Box b = v.personBox();
        if (b != null) {
            if (!Boolean.TRUE.equals(v.personDetected()) || !Double.isFinite(b.x()) || !Double.isFinite(b.y())
                    || !Double.isFinite(b.width()) || !Double.isFinite(b.height()) || b.x() < 0 || b.y() < 0
                    || b.width() <= 0 || b.height() <= 0 || b.x() + b.width() > 1.000001 || b.y() + b.height() > 1.000001) throw AiException.badOutput();
        }
        // 稳定性固定 UNKNOWN，绝不采信单帧模型声称“已站稳”。目标不存在时不指导人物。
        return new Vision(v.personDetected(), b, v.assessment(),
                Boolean.FALSE.equals(v.personDetected()) ? "未发现人物，请等待目标进入画面" : v.suggestion(),
                Boolean.FALSE.equals(v.personDetected()) ? "" : v.guidance(), "UNKNOWN");
    }
    private static boolean valid(String s, int max) { return s != null && s.length() <= max; }

    public Result<Transcript> transcribe(byte[] bytes) {
        String audio = MediaInput.wav(bytes);
        if (!live()) return result(new Transcript("帮我拍一张居中的半身照", "zh"), "MOCK", "none", "固定模拟转写，未识别上传音频；不会自动执行转写中的指令");
        provider.require(properties.asr());
        String text;
        if ("OPENAI_AUDIO".equals(properties.asrProtocol())) {
            JsonNode response = budget.call(() -> provider.transcribeMultipart(properties.asr(), bytes));
            if (!response.path("text").isString() || response.path("text").asString().isBlank()) throw AiException.badOutput();
            text = response.path("text").asString().trim();
        } else if ("QWEN_CHAT".equals(properties.asrProtocol())) {
            Map<String, Object> body = Map.of("model", properties.asr().model(), "messages",
                    List.of(Map.of("role", "user", "content", List.of(Map.of("type", "input_audio", "input_audio", Map.of("data", audio))))),
                    "stream", false, "asr_options", Map.of("language", "zh", "enable_itn", false));
            text = provider.content(budget.call(() -> provider.json(properties.asr(), body))).trim();
        } else {
            throw AiException.badInput("asr-protocol 只能为 OPENAI_AUDIO 或 QWEN_CHAT");
        }
        if (text.length() > 600) throw AiException.badOutput();
        return result(new Transcript(text, "zh"), "MODEL", properties.asr().model(), "仅转写；还需将文字传入指令解析接口，不自动执行动作");
    }
    public Audio speak(SpeechRequest request) {
        String text = CommandPolicy.text(request == null ? null : request.text(), 160, "text");
        if (!live()) return new Audio(MediaInput.mockTone(), "audio/wav", "MOCK");
        provider.require(properties.tts());
        if (!("OPENAI_AUDIO".equals(properties.ttsProtocol()) || "DASHSCOPE".equals(properties.ttsProtocol()))) throw AiException.badInput("tts-protocol 只能为 OPENAI_AUDIO 或 DASHSCOPE");
        return budget.call(() -> {
            ProviderClient.Reply response;
            if ("DASHSCOPE".equals(properties.ttsProtocol())) {
                JsonNode data = provider.json(properties.tts(), Map.of("model", properties.tts().model(), "input",
                        Map.of("text", text, "voice", properties.voice(), "language_type", "Chinese")));
                String url = data.path("output").path("audio").path("url").asString("");
                if (url.isBlank()) throw AiException.badOutput();
                response = provider.audioDownload(url);
            } else {
                response = provider.post(properties.tts(), Map.of("model", properties.tts().model(), "input", text,
                        "voice", properties.voice(), "response_format", "wav"), "audio/*", 8_000_000);
            }
            byte[] b = response.bytes();
            if (b.length >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W') return new Audio(b, "audio/wav", "LIVE");
            if (b.length >= 3 && (b[0] == 'I' && b[1] == 'D' && b[2] == '3' || (b[0] & 255) == 255 && (b[1] & 224) == 224)) return new Audio(b, "audio/mpeg", "LIVE");
            throw new AiException(HttpStatus.BAD_GATEWAY, "INVALID_TTS_AUDIO", "TTS 未返回支持的 WAV/MP3 音频，请确认平台路由与模型协议");
        });
    }
}
