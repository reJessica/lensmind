package com.example.lensmind.ai;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpSession;
import tools.jackson.databind.ObjectMapper;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class MotionPlanTests {
    private final ObjectMapper json = new ObjectMapper();
    private final AiModelClient.MotionAction left = new AiModelClient.MotionAction("MOVE", "LEFT", 1);

    @Test void bothAssistantAndVisionUseTheDualOutputContract() {
        var client = new AiModelClient(json, "api.openai.com") {
            @Override String complete(Connection connection, String system, String prompt, String scene, String reference, int tokens) {
                assertTrue(system.contains("feedback")); assertTrue(system.contains("actions"));
                assertTrue(system.contains("step 固定为1"));
                return "{\"feedback\":\"建议已生成。\",\"actions\":[]}";
            }
        };
        var connection = client.connection("https://api.openai.com/v1", "test", "fake-key");
        assertEquals("建议已生成。", client.assist(connection, "看看画面", null, null).feedback());
        assertTrue(client.analyze(connection, "分析画面", null, null).actions().isEmpty());
    }

    @Test void feedbackAndActionsAreSeparateAndOldResponsesRemainCompatible() {
        var client = new AiModelClient(json, "api.openai.com");
        var reply = client.guidance("""
                {"feedback":"已生成向左调整计划。","actions":[{"type":"MOVE","direction":"LEFT","step":1}]}
                """);
        assertEquals("已生成向左调整计划。", reply.feedback());
        assertEquals(List.of(left), reply.actions());
        var old = client.guidance("{\"summary\":\"请看镜头。\"}");
        assertEquals("请看镜头。", old.feedback()); assertTrue(old.actions().isEmpty());
    }

    @Test void rejectsJointAnglesCodeBadDirectionsAndLargeOrMultipleSteps() {
        var client = new AiModelClient(json, "api.openai.com");
        for (String actions : List.of("{}", "[{\"type\":\"RUN_CODE\",\"direction\":\"LEFT\",\"step\":1}]",
                "[{\"type\":\"MOVE\",\"direction\":\"JOINT_1\",\"step\":1}]",
                "[{\"type\":\"MOVE\",\"direction\":\"LEFT\",\"step\":2}]",
                "[{\"type\":\"MOVE\",\"direction\":\"LEFT\",\"step\":1.0}]", "[{},{}]")) {
            assertThrows(AiException.class, () -> client.guidance("{\"feedback\":\"调整建议\",\"actions\":" + actions + "}"));
        }
    }

    @Test void persistedJsonIsIndependentOfSpeechAndHasExpiryAndProvenance(@TempDir Path root) throws Exception {
        var store = new MotionPlanStore(root.toString());
        var document = store.save("owner", "相机向左一点", "image-data", List.of(left));
        var plan = json.readTree(store.read("owner", document.plan().planId()));
        assertEquals("lensmind.motion.v1", plan.path("schemaVersion").asString());
        assertEquals("PROPOSED", plan.path("status").asString());
        assertFalse(plan.path("executed").asBoolean());
        assertTrue(plan.path("createdAt").isTextual());
        assertEquals(60, java.time.Duration.between(java.time.Instant.parse(plan.path("createdAt").asString()),
                java.time.Instant.parse(plan.path("expiresAt").asString())).toSeconds());
        assertEquals(64, plan.path("sceneSha256").asString().length());
        assertEquals("LEFT", plan.path("actions").path(0).path("direction").asString());
        assertArrayEquals(store.read("owner", document.plan().planId()), Files.readAllBytes(root.resolve(document.fileName())));
        assertFalse(plan.has("feedback")); assertFalse(plan.has("apiKey")); assertFalse(plan.toString().contains("image-data"));
        assertEquals(404, assertThrows(AiException.class, () -> store.read("other", document.plan().planId())).status().value());
    }

    @Test void cropQuestionsAndHumanGuidanceNeverProduceMotionEvenIfModelRequestsIt(@TempDir Path root) {
        var store = new MotionPlanStore(root.toString());
        for (String text : List.of("人物靠左一点", "放大一点", "相机不要移动", "相机向左可以吗？", "怎么调整镜头", "抬起你的右手")) {
            var document = store.save("owner", text, null, List.of(left));
            assertEquals("NO_ACTION", document.plan().status()); assertTrue(document.plan().actions().isEmpty());
        }
    }

    private MockHttpServletRequest request(Map<String, Object> input) {
        var request = new MockHttpServletRequest();
        request.setServerName("localhost"); request.setRemoteAddr("127.0.0.1");
        request.setContentType("application/json"); request.setContent(json.writeValueAsBytes(input));
        return request;
    }

    @Test void controllerReturnsSpeechAndDownloadableFileWithoutCallingDevice(@TempDir Path root) {
        var client = mock(AiModelClient.class);
        var model = new AiModelClient.Connection(java.net.URI.create("https://api.openai.com/v1/chat/completions"), "test", "fake-key");
        when(client.connection(anyString(), anyString(), anyString())).thenReturn(model);
        when(client.assist(eq(model), eq("相机向左一点"), isNull(), isNull())).thenReturn(
                new AiModelClient.Guidance("左移意图", List.of(), List.of(), List.of(), null, "调整计划已生成。", List.of(left)));
        var controller = new AiController(client, json, new MotionPlanStore(root.toString()));
        var open = request(Map.of("baseUrl", "https://api.openai.com/v1", "model", "test", "apiKey", "fake-key"));
        var connected = (Map<?, ?>) controller.connect(open).getBody();
        var input = request(Map.of("connectionId", connected.get("id"), "prompt", "相机向左一点", "mode", "assistant"));
        input.setSession((MockHttpSession) open.getSession());
        var body = (Map<?, ?>) controller.analyze(input).getBody();
        assertEquals("调整计划已生成。", body.get("feedback"));
        var file = (MotionPlanStore.Document) body.get("controlPlan");
        var download = controller.downloadPlan(file.plan().planId(), input);
        assertTrue(download.getHeaders().getFirst("Content-Disposition").contains(".json"));
        assertEquals("LEFT", json.readTree(download.getBody()).path("actions").path(0).path("direction").asString());
        assertEquals(404, assertThrows(AiException.class, () -> controller.downloadPlan(file.plan().planId(), request(Map.of()))).status().value());
    }
}
