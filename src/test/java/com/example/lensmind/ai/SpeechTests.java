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
