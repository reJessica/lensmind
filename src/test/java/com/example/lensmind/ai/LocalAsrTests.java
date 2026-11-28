package com.example.lensmind.ai;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.*;
import org.springframework.mock.web.MockHttpServletRequest;
import tools.jackson.databind.ObjectMapper;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;

class LocalAsrTests {
    private final ObjectMapper mapper = new ObjectMapper();
    private final AtomicInteger calls = new AtomicInteger();
    private HttpServer server;
    private LocalAsrController controller;
    private final String id = "12345678-1234-1234-1234-123456789012";
    @BeforeEach void start() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            calls.incrementAndGet();
            String path = exchange.getRequestURI().getPath();
            byte[] body = exchange.getRequestBody().readAllBytes();
            String json = path.equals("/health") ? "{\"ready\":true,\"mode\":\"LOCAL\"}"
                    : path.equals("/sessions") ? "{\"id\":\"" + id + "\",\"mode\":\"LOCAL\"}"
                    : path.endsWith("/audio") ? "{\"results\":[{\"text\":\"拍摄\",\"final\":true,\"segment\":0}],\"mode\":\"LOCAL\"}"
                    : "{\"closed\":true}";
            if (path.endsWith("/audio") && body.length != 16) json = "{}";
            byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, bytes.length); exchange.getResponseBody().write(bytes); exchange.close();
        });
        server.start(); controller = new LocalAsrController(mapper, server.getAddress().getPort());
    }
    @AfterEach void stop() { server.stop(0); }
    private MockHttpServletRequest request() {
        var request = new MockHttpServletRequest(); request.setServerName("localhost"); request.setServerPort(8080); request.setRemoteAddr("127.0.0.1"); return request;
    }
    @Test void sameBrowserCanStreamAndResetButAnotherSessionCannot() throws Exception {
        var request = request();
        controller.create(mapper.readTree("{\"sampleRate\":16000}"), request);
        request.setContent(new byte[16]);
        var body = (tools.jackson.databind.JsonNode) controller.audio(id, request).getBody();
        assertEquals("拍摄", body.path("results").path(0).path("text").asString());
        assertEquals("LOCAL", body.path("mode").asString());
        assertEquals(409, assertThrows(AiException.class, () -> controller.audio(id, request())).status().value());
        controller.reset(id, request); controller.close(id, request);
        assertEquals(409, assertThrows(AiException.class, () -> controller.audio(id, request)).status().value());
    }
    @Test void remoteClientsInvalidRatesAndInvalidPcmNeverReachInference() throws Exception {
        var remote = request(); remote.setRemoteAddr("192.0.2.1");
        assertEquals(403, assertThrows(AiException.class, () -> controller.status(remote)).status().value());
        assertThrows(AiException.class, () -> controller.create(mapper.readTree("{\"sampleRate\":48000}"), request()));
        assertEquals(0, calls.get());
        var request = request(); controller.create(mapper.readTree("{\"sampleRate\":16000}"), request);
        request.setContent(new byte[3]);
        assertEquals(400, assertThrows(AiException.class, () -> controller.audio(id, request)).status().value());
        request.setContent(new byte[32772]);
        assertEquals(400, assertThrows(AiException.class, () -> controller.audio(id, request)).status().value());
        assertEquals(1, calls.get());
    }
    @Test void missingLocalServiceIsExplicitAndCannotFallBackToCloud() {
        server.stop(0);
        var error = assertThrows(AiException.class, () -> controller.status(request()));
        assertEquals(503, error.status().value());
        assertTrue(error.getMessage().contains("不会自动切换云端"));
    }
}
