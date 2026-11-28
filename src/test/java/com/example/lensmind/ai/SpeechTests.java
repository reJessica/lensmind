package com.example.lensmind.ai;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockMultipartFile;
import tools.jackson.databind.ObjectMapper;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class SpeechTests {
    private final ObjectMapper mapper = new ObjectMapper();
    private MockHttpServletRequest request() {
        var request = new MockHttpServletRequest();
        request.setServerName("localhost"); request.setServerPort(8080); request.setRemoteAddr("127.0.0.1");
        return request;
    }
    private SpeechController.Configure config(String key) {
        return new SpeechController.Configure(SpeechController.ASR, SpeechController.TTS, "workspace-123", key);
    }
    private AiProperties properties(int budget) {
        return new AiProperties(AiProperties.Mode.MOCK, budget, 3, null, null, null, "", "", "", false, false);
    }

    @Test void geminiSessionUsesNativeEndpointAndSharesBudget() {
        var provider = mock(ProviderClient.class);
        var budget = new LiveCallBudget(properties(1));
        var controller = new SpeechController(mock(DashScopeSpeechClient.class), provider, budget, "fake-key");
        var request = request();
        var body = (Map<?, ?>) controller.configure(new SpeechController.Configure("whisper-1", SpeechController.GEMINI_TTS, "", "", "uniapi"), request).getBody();
        assertEquals("Kore", body.get("voice"));
        when(provider.geminiSpeech(any(), anyString(), anyDouble())).thenAnswer(call -> {
            var endpoint = (AiProperties.Endpoint) call.getArgument(0);
            assertEquals("https://api.uniapi.io/gemini/v1beta/models/gemini-3.8-flash-lite-tts:generateContent", endpoint.url());
            assertEquals("fake-key", endpoint.apiKey());
            return MediaInput.mockTone();
        });
        var input = new SpeechController.Synthesis(body.get("id").toString(), "请拍照", 1);
        assertEquals("audio/wav", controller.synthesize(input, request).getHeaders().getContentType().toString());
        assertEquals(1, budget.used());
        assertThrows(AiException.class, () -> controller.synthesize(input, request));
        verify(provider, times(1)).geminiSpeech(any(), anyString(), anyDouble());
        verify(provider, never()).post(any(), anyMap(), anyString(), anyInt());
    }

    @Test void geminiNativeProtocolSendsOnlyGoogleKeyAndRejectsNonAudioJson() throws Exception {
        var server = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        byte[] tone = MediaInput.mockTone();
        byte[] reply = mapper.writeValueAsBytes(Map.of("candidates", java.util.List.of(Map.of("content", Map.of("parts", java.util.List.of(Map.of("inlineData", Map.of("mimeType", "audio/wav", "data", java.util.Base64.getEncoder().encodeToString(tone)))))))));
        var headers = new java.util.concurrent.atomic.AtomicReference<com.sun.net.httpserver.Headers>();
        var body = new java.util.concurrent.atomic.AtomicReference<String>();
        server.createContext("/gemini", exchange -> {
            headers.set(exchange.getRequestHeaders()); body.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            exchange.sendResponseHeaders(200, reply.length); exchange.getResponseBody().write(reply); exchange.close();
        });
        server.start();
        try {
            var client = new ProviderClient(properties(1), mapper);
            var endpoint = new AiProperties.Endpoint("http://127.0.0.1:" + server.getAddress().getPort() + "/gemini", SpeechController.GEMINI_TTS, "fake-key");
            assertArrayEquals(tone, client.geminiSpeech(endpoint, "请拍照", 1));
            assertEquals("fake-key", headers.get().getFirst("x-goog-api-key"));
            assertNull(headers.get().getFirst("Authorization"));
            var json = mapper.readTree(body.get());
            assertEquals("请拍照", json.path("contents").path(0).path("parts").path(0).path("text").asString());
            assertEquals("Kore", json.path("generationConfig").path("speechConfig").path("voiceConfig").path("prebuiltVoiceConfig").path("voiceName").asString());
            assertThrows(AiException.class, () -> client.geminiWav("{\"error\":\"fake-key\"}".getBytes(StandardCharsets.UTF_8)));
            byte[] invalid = new String(reply, StandardCharsets.UTF_8).replace("audio/wav", "text/plain").getBytes(StandardCharsets.UTF_8);
            assertThrows(AiException.class, () -> client.geminiWav(invalid));
        } finally { server.stop(0); }
    }

    @Test void uniapiUsesExistingLocalKeyAndFixedAudioEndpointsWithoutWorkspaceOrDashscope() throws Exception {
        var dashscope = mock(DashScopeSpeechClient.class);
        var provider = mock(ProviderClient.class);
        var budget = new LiveCallBudget(properties(8));
        var controller = new SpeechController(dashscope, provider, budget, "fake-local-uniapi-key");
        var request = request();
        var body = (Map<?, ?>) controller.configure(new SpeechController.Configure("whisper-1", "tts-1", "", "", "uniapi"), request).getBody();
        assertEquals("uniapi", body.get("provider")); assertEquals("", body.get("workspace")); assertEquals("alloy", body.get("voice"));
        assertFalse(body.toString().contains("fake-local-uniapi-key"));
        when(provider.transcribeMultipart(any(), any())).thenAnswer(call -> {
            var endpoint = (AiProperties.Endpoint) call.getArgument(0);
            assertEquals("https://api.uniapi.io/v1/audio/transcriptions", endpoint.url());
            assertEquals("whisper-1", endpoint.model()); assertEquals("fake-local-uniapi-key", endpoint.apiKey());
            return mapper.readTree("{\"text\":\"拍照\"}");
        });
        when(provider.post(any(), anyMap(), anyString(), anyInt())).thenAnswer(call -> {
            var endpoint = (AiProperties.Endpoint) call.getArgument(0);
            assertEquals("https://api.uniapi.io/v1/audio/speech", endpoint.url());
            Map<?, ?> payload = call.getArgument(1);
            assertEquals("tts-1", payload.get("model")); assertEquals("alloy", payload.get("voice"));
            return new ProviderClient.Reply(MediaInput.mockTone(), "audio/wav");
        });
        String id = body.get("id").toString();
        var file = new MockMultipartFile("audio", "clip.wav", "audio/wav", MediaInput.mockTone());
        assertEquals("拍照", ((Map<?, ?>) controller.transcribe(id, file, request).getBody()).get("text"));
        var audio = controller.synthesize(new SpeechController.Synthesis(id, "请看镜头", 1), request);
        assertEquals("audio/wav", audio.getHeaders().getContentType().toString());
        assertEquals(2, budget.used()); verifyNoInteractions(dashscope);
    }

    @Test void uniapiCredentialsCannotBeReusedForDashscopeOrMixedModels() {
        var provider = mock(ProviderClient.class);
        var controller = new SpeechController(mock(DashScopeSpeechClient.class), provider, new LiveCallBudget(properties(8)), "fake-local-key");
        var request = request();
        controller.configure(new SpeechController.Configure("whisper-1", "tts-1", "", "", "uniapi"), request);
        assertThrows(AiException.class, () -> controller.configure(new SpeechController.Configure(SpeechController.ASR, SpeechController.TTS, "workspace-123", "", "dashscope"), request));
        assertThrows(AiException.class, () -> controller.configure(new SpeechController.Configure("whisper-1", SpeechController.TTS, "", "dummy", "uniapi"), request));
        assertThrows(AiException.class, () -> SpeechController.audioType("{\"error\":\"fake-secret\"}".getBytes(StandardCharsets.UTF_8)));
        controller.disconnect(request);
        assertEquals(true, ((Map<?, ?>) controller.status(request).getBody()).get("localUniapiKeyConfigured"));
        verifyNoInteractions(provider);
    }

    @Test void savingIsLocalOnlyAndCannotSelectArbitraryModelsOrDestinations() {
        var client = mock(DashScopeSpeechClient.class);
        var controller = new SpeechController(client);
        var request = request();
        var body = (Map<?, ?>) controller.configure(config("fake-secret-only"), request).getBody();
        assertEquals(true, body.get("configured")); assertEquals(false, body.get("verified"));
        assertFalse(body.toString().contains("fake-secret-only"));
        assertFalse(config("fake-secret-only").toString().contains("fake-secret-only"));
        assertThrows(AiException.class, () -> controller.configure(new SpeechController.Configure("other-model", SpeechController.TTS, "id", "dummy"), request));
        assertThrows(AiException.class, () -> controller.configure(new SpeechController.Configure(SpeechController.ASR, SpeechController.TTS, "evil.example.com/path", "dummy"), request));
        assertThrows(AiException.class, () -> controller.configure(config(""), request()));
        var remote = request(); remote.setRemoteAddr("192.0.2.1");
        assertEquals(403, assertThrows(AiException.class, () -> controller.status(remote)).status().value());
        var crossOrigin = request(); crossOrigin.addHeader("Origin", "https://example.com");
        assertEquals(403, assertThrows(AiException.class, () -> controller.configure(config("dummy"), crossOrigin)).status().value());
        verifyNoInteractions(client);
    }

    @Test void staleOrForeignConnectionsCannotSubmitAudioAndKeysCanOnlyBeReusedInSameWorkspace() throws Exception {
        var client = mock(DashScopeSpeechClient.class);
        when(client.transcribe(any(), any())).thenReturn("拍照");
        var controller = new SpeechController(client);
        var request = request();
        var first = (Map<?, ?>) controller.configure(config("fake-secret-only"), request).getBody();
        var second = (Map<?, ?>) controller.configure(config(""), request).getBody();
        assertNotEquals(first.get("id"), second.get("id"));
        var file = new MockMultipartFile("audio", "clip.wav", "audio/wav", MediaInput.mockTone());
        assertEquals(409, assertThrows(AiException.class, () -> controller.transcribe(first.get("id").toString(), file, request)).status().value());
        assertEquals(409, assertThrows(AiException.class, () -> controller.transcribe(second.get("id").toString(), file, request())).status().value());
        assertEquals("拍照", ((Map<?, ?>) controller.transcribe(second.get("id").toString(), file, request).getBody()).get("text"));
        assertThrows(AiException.class, () -> controller.configure(new SpeechController.Configure(SpeechController.ASR, SpeechController.TTS, "other-workspace", ""), request));
        controller.disconnect(request);
        assertEquals(409, assertThrows(AiException.class, () -> controller.transcribe(second.get("id").toString(), file, request)).status().value());
        verify(client, times(1)).transcribe(any(), any());
    }

    @Test void disconnectingPhotographyAndSpeechDoNotInvalidateEachOther() {
        var model = new AiModelClient(mapper, "dashscope.aliyuncs.com") { @Override void check(Connection connection) {} };
        var photography = new AiController(model, mapper);
        var speech = new SpeechController(mock(DashScopeSpeechClient.class));
        var request = request(); request.setContentType("application/json");
        request.setContent(mapper.writeValueAsBytes(Map.of("baseUrl", "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "model", "qwen3.5-flash-2026-02-23", "apiKey", "fake-secret-only")));
        photography.connect(request); speech.configure(config("dummy"), request);
        speech.disconnect(request);
        assertEquals(true, ((Map<?, ?>) photography.status(request).getBody()).get("connected"));
        speech.configure(config("dummy"), request); photography.disconnect(request);
        assertEquals(true, ((Map<?, ?>) speech.status(request).getBody()).get("configured"));
    }

    private String response(String event, Map<String, Object> payload) {
        return mapper.writeValueAsString(Map.of("header", Map.of("task_id", "task-1", "event", event), "payload", payload));
    }
    @Test void protocolWaitsForFinalSentencesAndHandlesFragmentationAndDuplicates() {
        var socket = mock(WebSocket.class);
        var task = new DashScopeSpeechClient.Task(mapper, "task-1");
        String started = response("task-started", Map.of());
        task.onText(socket, started.substring(0, 12), false);
        assertFalse(task.started.isDone());
        task.onText(socket, started.substring(12), true);
        assertTrue(task.started.isDone());
        task.onText(socket, response("result-generated", Map.of("output", Map.of("sentence", Map.of("text", "错误中间结果", "sentence_end", false)))), true);
        String finalText = response("result-generated", Map.of("output", Map.of("sentence", Map.of("text", "拍照", "sentence_end", true, "sentence_id", 1))));
        task.onText(socket, finalText, true); task.onText(socket, finalText, true);
        task.onBinary(socket, ByteBuffer.wrap(new byte[]{'I', 'D', '3'}), true);
        task.onText(socket, response("task-finished", Map.of()), true);
        assertEquals("拍照", task.transcript()); assertEquals(3, task.audio.size());
        assertFalse(task.finished.isCompletedExceptionally());
        var start = mapper.valueToTree(DashScopeSpeechClient.start("task-1", true, 1.2));
        assertEquals(SpeechController.TTS, start.path("payload").path("model").asString());
        assertEquals(SpeechController.VOICE, start.path("payload").path("parameters").path("voice").asString());
        assertTrue(start.path("payload").path("input").isObject());
        assertEquals(SpeechController.ASR, mapper.valueToTree(DashScopeSpeechClient.start("task-1", false, 1)).path("payload").path("model").asString());
    }

    @Test void protocolErrorsCannotLeakProviderMessagesOrPretendToSucceed() {
        var socket = mock(WebSocket.class);
        var task = new DashScopeSpeechClient.Task(mapper, "task-1");
        task.onText(socket, response("task-failed", Map.of("error_message", "fake-secret-only")), true);
        assertTrue(task.finished.isCompletedExceptionally());
        assertFalse(assertThrows(Exception.class, task.finished::join).getMessage().contains("fake-secret-only"));
        var wrongTask = new DashScopeSpeechClient.Task(mapper, "other-task");
        wrongTask.onText(socket, response("task-finished", Map.of()), true);
        assertTrue(wrongTask.finished.isCompletedExceptionally());
        var closed = new DashScopeSpeechClient.Task(mapper, "task-1");
        closed.onClose(socket, 1000, "fake-secret-only");
        assertTrue(closed.finished.isCompletedExceptionally());
        var empty = new DashScopeSpeechClient.Task(mapper, "task-1");
        assertThrows(AiException.class, empty::transcript);
    }

    @Test void audioAndBudgetAreCheckedBeforeAnyNetworkCall() {
        assertEquals(16000, DashScopeSpeechClient.pcm(MediaInput.mockTone()).length);
        assertThrows(AiException.class, () -> DashScopeSpeechClient.pcm("not-a-wav".getBytes(StandardCharsets.UTF_8)));
        var properties = properties(0);
        var budget = new LiveCallBudget(properties);
        var client = new DashScopeSpeechClient(mapper, properties, budget);
        var connection = new SpeechController.Connection(SpeechController.ASR, SpeechController.TTS, "workspace-123", "dummy");
        assertEquals("wss://workspace-123.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference", DashScopeSpeechClient.endpoint(connection).toString());
        assertEquals(429, assertThrows(AiException.class, () -> client.transcribe(connection, MediaInput.mockTone())).status().value());
        assertEquals(0, budget.used());
        assertThrows(AiException.class, () -> DashScopeSpeechClient.endpoint(new SpeechController.Connection(SpeechController.ASR, SpeechController.TTS, "example.com", "dummy")));
    }
}
