package com.example.lensmind.ai;

import org.junit.jupiter.api.Test;
import org.springframework.core.io.support.PropertiesLoaderUtils;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpSession;
import tools.jackson.databind.ObjectMapper;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import javax.imageio.ImageIO;

import static org.junit.jupiter.api.Assertions.*;

class AiTests {
    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void defaultConfigurationAcceptsSjtuVisionEndpoint() throws Exception {
        var properties = PropertiesLoaderUtils.loadAllProperties("application.properties");
        String hosts = new MockEnvironment().resolveRequiredPlaceholders(properties.getProperty("lensmind.ai.allowed-hosts"));
        var client = new AiModelClient(mapper, hosts);
        var connection = client.connection("https://models.sjtu.edu.cn/api/v1", "qwen", "fake-test-only");
        assertEquals("https://models.sjtu.edu.cn/api/v1/chat/completions", connection.endpoint.toString());
        assertEquals("qwen", connection.model);
        assertThrows(AiException.class, () -> client.connection("https://models.sjtu.edu.cn.example.com/api/v1", "qwen", "fake-test-only"));
    }

    @Test void fixedDashscopeSnapshotDisablesThinkingWithoutChangingOtherProviders() {
        var client = new AiModelClient(mapper, "dashscope.aliyuncs.com,zgc.apihy.com");
        var pinned = client.connection("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3.5-flash-2026-02-23", "fake-test-only");
        var payload = client.payload(pinned, "test", "hello", null, null, 100);
        assertEquals("qwen3.5-flash-2026-02-23", payload.get("model"));
        assertEquals(false, payload.get("enable_thinking"));
        var existing = client.connection("https://zgc.apihy.com/v1", "qwen3.5-27b", "fake-test-only");
        assertFalse(client.payload(existing, "test", "hello", null, null, 100).containsKey("enable_thinking"));
    }

    @Test void photographyConnectionTestsRespectTheSharedLiveCallBudget() {
        var properties = new AiProperties(AiProperties.Mode.MOCK, 0, 3, null, null, null, "", "", "", false, false);
        var client = new AiModelClient(mapper, "dashscope.aliyuncs.com", new LiveCallBudget(properties));
        var connection = client.connection("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3.5-flash-2026-02-23", "fake-test-only");
        assertEquals(429, assertThrows(AiException.class, () -> client.check(connection)).status().value());
    }

    @Test
    void defaultConfigurationAcceptsTeamProvidersWithoutAllowingSimilarDomains() throws Exception {
        var properties = PropertiesLoaderUtils.loadAllProperties("application.properties");
        String hosts = new MockEnvironment().resolveRequiredPlaceholders(properties.getProperty("lensmind.ai.allowed-hosts"));
        var client = new AiModelClient(mapper, hosts);
        for (String host : List.of("zgc.apihy.com", "api.uniapi.io")) {
            var connection = client.connection("https://" + host + "/v1", "qwen3.5-27b", "fake-test-only");
            assertEquals("https://" + host + "/v1/chat/completions", connection.endpoint.toString());
            assertThrows(AiException.class, () -> client.connection("https://" + host + ".example.com/v1", "qwen3.5-27b", "fake-test-only"));
        }
        String overridden = new MockEnvironment().withProperty("LENSMIND_AI_ALLOWED_HOSTS", "api.openai.com")
                .resolveRequiredPlaceholders(properties.getProperty("lensmind.ai.allowed-hosts"));
        var restricted = new AiModelClient(mapper, overridden);
        assertThrows(AiException.class, () -> restricted.connection("https://zgc.apihy.com/v1", "qwen3.5-27b", "fake-test-only"));
    }

    @Test
    void connectionChecksImagesAndAnalysisSendsBothInOrder() throws Exception {
        String scene = jpeg(72);
        String reference = jpeg(128);
        var client = new StubClient();
        var controller = new AiController(client, mapper);
        var open = request(Map.of("baseUrl", "https://api.openai.com/v1/", "model", "vision-model", "apiKey", "fake-test-only"));
        var connection = (Map<?, ?>) controller.connect(open).getBody();
        assertEquals(true, connection.get("connected"));
        assertEquals("https://api.openai.com/v1/chat/completions", client.model.endpoint.toString());
        assertFalse(connection.toString().contains("fake-test-only"));
        assertTrue(client.scene.startsWith(AiModelClient.JPEG));
        assertNull(client.reference);

        var analyze = request(Map.of("connectionId", connection.get("id"), "prompt", "树左上四格，人右下四格",
                "scene", scene, "reference", reference));
        analyze.setSession((MockHttpSession) open.getSession());
        var response = controller.analyze(analyze);
        var guidance = (AiModelClient.Guidance) response.getBody();
        assertEquals(List.of(0, 1, 3, 4), guidance.targets().get(0).cells());
        assertEquals(List.of(4, 5, 7, 8), guidance.targets().get(1).cells());
        assertEquals("no-store", response.getHeaders().getCacheControl());
        var content = mapper.valueToTree(client.sentPayload).path("messages").path(1).path("content");
        assertTrue(content.path(0).path("text").asText().contains("树左上四格"));
        assertEquals(scene, content.path(1).path("image_url").path("url").asText());
        assertEquals(reference, content.path(2).path("image_url").path("url").asText());
        assertFalse(client.sentPayload.toString().contains("fake-test-only"));
        controller.disconnect(analyze);
        assertEquals(409, assertThrows(AiException.class, () -> controller.analyze(request(Map.of()))).status().value());
    }

    @Test
    void blocksUnapprovedDestinationsAndCrossOriginBrowserRequests() {
        var client = new StubClient();
        for (String url : List.of("https://example.com/v1", "http://api.openai.com/v1", "https://127.0.0.1/v1",
                "https://api.openai.com:123/v1", "https://api.openai.com@google.com/v1", "https://api.openai.com/v1?key=value")) {
            assertEquals(400, assertThrows(AiException.class, () -> client.connection(url, "vision-model", "dummy")).status().value());
        }
        var controller = new AiController(client, mapper);
        var crossOrigin = request(Map.of());
        crossOrigin.addHeader("Origin", "http://localhost:4030");
        assertEquals(403, assertThrows(AiException.class, () -> controller.status(crossOrigin)).status().value());
        var external = request(Map.of());
        external.setRemoteAddr("192.0.2.1");
        assertEquals(403, assertThrows(AiException.class, () -> controller.status(external)).status().value());
    }

    @Test
    void assistantAcceptsTextWithoutAnImageAndRestrictsReturnedSettings() {
        var client = new StubClient();
        var controller = new AiController(client, mapper);
        var open = request(Map.of("baseUrl", "https://api.openai.com/v1", "model", "vision-model", "apiKey", "fake-test-only"));
        var connection = (Map<?, ?>) controller.connect(open).getBody();
        var input = request(Map.of("connectionId", connection.get("id"), "mode", "assistant", "prompt", "阴天人像如何选衣服？"));
        input.setSession((MockHttpSession) open.getSession());
        assertEquals(200, controller.analyze(input).getStatusCode().value());
        assertNull(client.scene);
        assertNull(client.reference);
        assertEquals("阴天人像如何选衣服？", mapper.valueToTree(client.sentPayload).path("messages").path(1).path("content").asText());
        var settings = client.guidance("""
                {"summary":"已理解构图要求","settings":{"framing":"half","cells":[4,5,4],"part":"head","zoom":"stop","action":"capture","ratio":"1:1"}}
                """).settings();
        assertEquals("half", settings.framing());
        assertEquals(List.of(4, 5), settings.cells());
        assertEquals("head", settings.part());
        assertNull(settings.zoom());
        assertEquals("1:1", settings.ratio());
        assertNull(client.guidance("{\"summary\":\"回答\",\"settings\":{\"ratio\":\"17:2\"}}").settings().ratio());
        assertNull(client.guidance("{\"summary\":\"回答\",\"settings\":{\"cells\":[9]}}").settings());
    }

    @Test
    void staleConnectionAndInvalidJpegCannotSendAnyPhoto() {
        var client = new StubClient();
        var controller = new AiController(client, mapper);
        var open = request(Map.of("baseUrl", "https://api.openai.com/v1", "model", "vision-model", "apiKey", "fake-test-only"));
        var connection = (Map<?, ?>) controller.connect(open).getBody();
        assertEquals(409, assertThrows(AiException.class, () -> {
            var input = request(Map.of("connectionId", "stale", "scene", "fake"));
            input.setSession((MockHttpSession) open.getSession());
            controller.analyze(input);
        }).status().value());
        var badImage = request(Map.of("connectionId", connection.get("id"), "scene", AiModelClient.JPEG + "YXNkZg=="));
        badImage.setSession((MockHttpSession) open.getSession());
        assertEquals(400, assertThrows(AiException.class, () -> controller.analyze(badImage)).status().value());
        assertEquals(1, client.calls);
    }

    private MockHttpServletRequest request(Map<String, ?> body) {
        var request = new MockHttpServletRequest();
        request.setContentType("application/json");
        request.setContent(mapper.writeValueAsBytes(body));
        return request;
    }

    private String jpeg(int size) throws Exception {
        var output = new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(size, size, BufferedImage.TYPE_INT_RGB), "jpeg", output);
        return AiModelClient.JPEG + Base64.getEncoder().encodeToString(output.toByteArray());
    }

    private final class StubClient extends AiModelClient {
        private int calls;
        private Connection model;
        private String scene;
        private String reference;
        private Map<String, Object> sentPayload;

        StubClient() { super(AiTests.this.mapper, "api.openai.com,openrouter.ai"); }

        @Override
        String complete(Connection model, String system, String prompt, String scene, String reference, int tokens) {
            this.calls++;
            this.model = model;
            this.scene = scene;
            this.reference = reference;
            this.sentPayload = payload(model, system, prompt, scene, reference, tokens);
            if (calls == 1) return "OK";
            return """
                    ```json
                    {"summary":"人物可往画面右侧站一些。","observations":[{"name":"树","location":"画面中央"}],
                    "targets":[{"name":"树","cells":[0,1,3,4,4,9,"7"],"advice":"调整取景"},
                    {"name":"人物","cells":[4,5,7,8],"advice":"往右侧站"}],"steps":["先调整取景。"]}
                    ```
                    """;
        }
    }
}
