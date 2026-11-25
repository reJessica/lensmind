package com.example.lensmind.ai;

import static com.example.lensmind.ai.AiContracts.*;
import static org.junit.jupiter.api.Assertions.*;
import com.sun.net.httpserver.HttpServer;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.*;
import org.springframework.core.io.DefaultResourceLoader;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** 所有 LIVE 测试都指向本机假服务；不读取用户 Key，不连接供应商，不产生费用。 */
class AiServiceTests {
    private HttpServer server;
    private String url;
    private final JsonMapper mapper = JsonMapper.builder().build();
    private JsonNode request;
    private byte[] rawRequest;
    private String requestContentType;
    private boolean transcriptionJson;
    private Map<String, String> upstreamError;
    private String output;
    private byte[] binary;
    private int httpStatus;
    private final AtomicInteger hits = new AtomicInteger();

    @BeforeEach void setup() throws Exception {
        httpStatus = 200;
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/test", exchange -> {
            hits.incrementAndGet();
            assertEquals("Bearer local-test-only", exchange.getRequestHeaders().getFirst("Authorization"));
            rawRequest = exchange.getRequestBody().readAllBytes();
            requestContentType = exchange.getRequestHeaders().getFirst("Content-Type");
            if (requestContentType.startsWith("application/json")) request = mapper.readTree(rawRequest);
            byte[] response = binary != null ? binary : mapper.writeValueAsBytes(transcriptionJson ? Map.of("text", output == null ? "" : output) : Map.of("choices",
                    java.util.List.of(Map.of("message", Map.of("content", output == null ? "" : output)))));
            if (upstreamError != null) response = mapper.writeValueAsBytes(Map.of("error", upstreamError));
            exchange.getResponseHeaders().set("Content-Type", binary != null ? "audio/wav" : "application/json");
            exchange.sendResponseHeaders(httpStatus, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        server.start();
        url = "http://127.0.0.1:" + server.getAddress().getPort() + "/test";
    }
    @AfterEach void close() { if (server != null) server.stop(0); }
    private AiProperties properties(AiProperties.Mode mode, int limit) {
        var endpoint = new AiProperties.Endpoint(url, "test-model", "local-test-only");
        return new AiProperties(mode, limit, 5, endpoint, endpoint, endpoint, "QWEN_CHAT", "OPENAI_AUDIO", "Cherry", false, false);
    }
    private AiService service(AiProperties properties, LiveCallBudget budget) throws Exception {
        return new AiService(properties, new ProviderClient(properties, mapper), budget, new DefaultResourceLoader());
    }
    private AiService service() throws Exception {
        var p = properties(AiProperties.Mode.LIVE, 8);
        return service(p, new LiveCallBudget(p));
    }
    @Test void stopAndNegationNeverCallModel() throws Exception {
        var p = properties(AiProperties.Mode.LIVE, 8);
        var budget = new LiveCallBudget(p);
        var ai = service(p, budget);
        assertEquals(Intent.STOP, ai.command(new CommandRequest("停止拍照", null, null)).data().type());
        assertEquals(Intent.CLARIFY, ai.command(new CommandRequest("不要拍照", null, null)).data().type());
        assertEquals(0, hits.get()); assertEquals(0, budget.used());
    }
    @Test void traditionalChineseSpeechControlWordsAreNormalized() throws Exception {
        var p = properties(AiProperties.Mode.MOCK, 0);
        var ai = service(p, new LiveCallBudget(p));
        var move = ai.command(new CommandRequest("相機向左一點", null, null)).data();
        assertEquals(Intent.MOVE, move.type()); assertEquals(Direction.LEFT, move.direction());
        assertEquals(Intent.STOP, ai.command(new CommandRequest("別動", null, null)).data().type());
        assertTrue(ai.command(new CommandRequest("縮小一點", null, null)).data().zoomDelta() < 0);
        assertEquals(0, hits.get());
    }
    @Test void structuredCommandUsesBackendModelAndNeverAllowsLargeStep() throws Exception {
        var ai = service();
        output = "{\"type\":\"MOVE\",\"direction\":\"LEFT\",\"step\":1,\"composition\":null,\"framing\":null,\"zoomDelta\":null,\"message\":\"请求微调\"}";
        assertEquals(Intent.MOVE, ai.command(new CommandRequest("相机向左一点", null, null)).data().type());
        assertFalse(request.path("enable_thinking").asBoolean());
        assertEquals(700, request.path("max_tokens").asInt());
        output = output.replace("\"step\":1", "\"step\":5");
        assertThrows(AiException.class, () -> ai.command(new CommandRequest("相机向左一点", null, null)));
    }
    @Test void modelCannotTurnDigitalZoomIntoMovement() throws Exception {
        output = "{\"type\":\"MOVE\",\"direction\":\"LEFT\",\"step\":1,\"composition\":null,\"framing\":null,\"zoomDelta\":null,\"message\":\"微调\"}";
        assertEquals(Intent.CLARIFY, service().command(new CommandRequest("放大一点", null, null)).data().type());
    }
    @Test void malformedOutputDoesNotBecomeSuccess() throws Exception {
        output = "不能输出JSON";
        var ai = service();
        AiException e = assertThrows(AiException.class, () -> ai.command(new CommandRequest("人物占比再大些", null, null)));
        assertEquals("INVALID_MODEL_OUTPUT", e.code());
    }
    @Test void visionUploadsPreparedImageAndNeverClaimsStability() throws Exception {
        output = "{\"personDetected\":true,\"personBox\":{\"x\":0.1,\"y\":0.1,\"width\":0.6,\"height\":0.8},\"assessment\":\"人物在画面内\",\"suggestion\":\"减少留白\",\"guidance\":\"请看镜头。\",\"stability\":\"STABLE\"}";
        var result = service().vision(image(), "frame-1", Instant.now().toString(), Composition.center, Framing.half);
        assertEquals("frame-1", result.data().frameId());
        assertEquals("UNKNOWN", result.data().analysis().stability());
        assertTrue(request.path("messages").path(1).path("content").path(1).path("image_url").path("url").asString().startsWith("data:image/jpeg;base64,"));
    }
    @Test void absentTargetCannotReturnMovementOrPersonGuidance() {
        Vision checked = AiService.validateVision(new Vision(false, null, "无人", "向左移动", "抬头", "STABLE"));
        assertEquals("", checked.guidance());
        assertEquals("未发现人物，请等待目标进入画面", checked.suggestion());
        assertEquals("UNKNOWN", checked.stability());
    }
    @Test void invalidBoundingBoxIsRejected() {
        assertThrows(AiException.class, () -> AiService.validateVision(new Vision(true, new Box(.9, .1, .5, .5), "", "", "", "UNKNOWN")));
    }
    @Test void asrUsesInputAudioAndReturnsOnlyTranscript() throws Exception {
        output = "帮我拍一张居中半身照";
        var result = service().transcribe(MediaInput.mockTone());
        assertEquals(output, result.data().text());
        assertEquals("input_audio", request.path("messages").path(0).path("content").path(0).path("type").asString());
        assertEquals(1, hits.get());
    }
    @Test void openAiAsrUsesMultipartFileInsteadOfChatJson() throws Exception {
        var base = properties(AiProperties.Mode.LIVE, 8);
        var p = new AiProperties(base.mode(), 8, 5, base.chat(), base.asr(), base.tts(), "OPENAI_AUDIO", "OPENAI_AUDIO", "alloy", false, false);
        transcriptionJson = true;
        output = "请看向镜头。";
        var result = service(p, new LiveCallBudget(p)).transcribe(MediaInput.mockTone());
        assertEquals(output, result.data().text());
        assertTrue(requestContentType.startsWith("multipart/form-data; boundary="));
        String multipart = new String(rawRequest, StandardCharsets.ISO_8859_1);
        assertTrue(multipart.contains("name=\"model\"\r\n\r\ntest-model"));
        assertTrue(multipart.contains("name=\"file\"; filename=\"recording.wav\""));
        assertTrue(multipart.contains("RIFF"));
        assertEquals(1, hits.get());
    }
    @Test void openAiAsrRejectsMissingTranscript() throws Exception {
        var base = properties(AiProperties.Mode.LIVE, 8);
        var p = new AiProperties(base.mode(), 8, 5, base.chat(), base.asr(), base.tts(), "OPENAI_AUDIO", "OPENAI_AUDIO", "alloy", false, false);
        var ai = service(p, new LiveCallBudget(p));
        output = "This is a chat response, not a transcript object";
        assertThrows(AiException.class, () -> ai.transcribe(MediaInput.mockTone()));
    }
    @Test void unsupportedAsrProtocolDoesNotSpendBudget() throws Exception {
        var base = properties(AiProperties.Mode.LIVE, 8);
        var p = new AiProperties(base.mode(), 8, 5, base.chat(), base.asr(), base.tts(), "UNKNOWN", "OPENAI_AUDIO", "alloy", false, false);
        var budget = new LiveCallBudget(p);
        var ai = service(p, budget);
        assertThrows(AiException.class, () -> ai.transcribe(MediaInput.mockTone()));
        assertEquals(0, budget.used()); assertEquals(0, hits.get());
    }
    @Test void ttsReturnsValidatedAudio() throws Exception {
        binary = MediaInput.mockTone();
        var result = service().speak(new SpeechRequest("请看向镜头。"));
        assertEquals("LIVE", result.mode()); assertEquals("audio/wav", result.contentType());
        assertEquals("请看向镜头。", request.path("input").asString());
    }
    @Test void ttsRejectsJsonDisguisedAsAudio() throws Exception {
        binary = "{\"error\":\"not audio\"}".getBytes(StandardCharsets.UTF_8);
        var ai = service();
        assertThrows(AiException.class, () -> ai.speak(new SpeechRequest("你好")));
    }
    @Test void failedCallsCountAndAreNeverAutomaticallyRetried() throws Exception {
        var p = properties(AiProperties.Mode.LIVE, 1);
        var budget = new LiveCallBudget(p);
        var ai = service(p, budget);
        httpStatus = 401;
        assertThrows(AiException.class, () -> ai.command(new CommandRequest("人物放大一些", null, null)));
        AiException e = assertThrows(AiException.class, () -> ai.command(new CommandRequest("人物放大一些", null, null)));
        assertEquals("LIVE_CALL_LIMIT", e.code()); assertEquals(1, hits.get()); assertEquals(1, budget.used());
    }
    @Test void overloadedProviderIsDistinguishedWithoutLeakingRawError() throws Exception {
        httpStatus = 429;
        upstreamError = Map.of("code", "api_limit", "message", "当前分组上游负载已饱和 secret-in-upstream-body");
        var ai = service();
        var error = assertThrows(AiException.class, () -> ai.speak(new SpeechRequest("请看镜头。")));
        assertEquals("PROVIDER_BUSY", error.code());
        assertEquals(503, error.status().value());
        assertFalse(error.getMessage().contains("secret-in-upstream-body"));
        assertEquals(1, hits.get());
    }
    @Test void quotaFailureIsDistinguishedFromUpstreamLoad() throws Exception {
        httpStatus = 429;
        upstreamError = Map.of("code", "insufficient_quota", "message", "quota exceeded");
        var ai = service();
        var error = assertThrows(AiException.class, () -> ai.speak(new SpeechRequest("请看镜头。")));
        assertEquals("PROVIDER_QUOTA_EXHAUSTED", error.code());
        assertEquals(1, hits.get());
    }
    @Test void mockModeHasNoExternalRequestsAndIsExplicitlyLabeled() throws Exception {
        var p = properties(AiProperties.Mode.MOCK, 0);
        var ai = service(p, new LiveCallBudget(p));
        assertEquals("MOCK", ai.command(new CommandRequest("放大一点", null, null)).source());
        assertNull(ai.vision(image(), "demo", Instant.now().toString(), Composition.center, Framing.half).data().analysis().personDetected());
        assertEquals("MOCK", ai.transcribe(MediaInput.mockTone()).mode());
        assertEquals("MOCK", ai.speak(new SpeechRequest("测试")).mode());
        assertEquals(0, hits.get());
        assertFalse(mapper.writeValueAsString(ai.status()).contains("local-test-only"));
    }
    @Test void invalidInputsFailBeforeExternalCalls() throws Exception {
        var ai = service();
        assertThrows(AiException.class, () -> ai.command(new CommandRequest(" ", null, null)));
        assertThrows(AiException.class, () -> ai.vision(new byte[]{1, 2}, "demo", Instant.now().toString(), Composition.center, Framing.full));
        assertThrows(AiException.class, () -> ai.transcribe("fake-webm".getBytes(StandardCharsets.UTF_8)));
        assertThrows(AiException.class, () -> ai.speak(new SpeechRequest("x".repeat(161))));
        assertEquals(0, hits.get());
    }
    private byte[] image() throws Exception {
        var out = new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(160, 120, BufferedImage.TYPE_INT_RGB), "png", out);
        return out.toByteArray();
    }
}
