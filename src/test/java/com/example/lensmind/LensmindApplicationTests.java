package com.example.lensmind;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"lensmind.ai.mode=MOCK", "lensmind.device.backend=mock"})
class LensmindApplicationTests {

    @LocalServerPort
    private int port;

    @Test
    void staleBuildTimestampCannotHideUpdatedControlAssets() throws Exception {
        var client = HttpClient.newHttpClient();
        for (String path : List.of("/", "/js/app.js", "/js/commands.js", "/css/style.css", "/js/settings.js", "/css/settings.css",
                "/js/model-presets.js", "/js/cloud-speech.js", "/js/pcm-worklet.js")) {
            var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                    .header("If-Modified-Since", "Fri, 01 Feb 1980 00:00:00 GMT")
                    .build();
            var response = client.send(request, HttpResponse.BodyHandlers.discarding());
            assertEquals(200, response.statusCode(), path);
            assertTrue(response.headers().firstValue("Cache-Control").orElse("").contains("no-store"), path);
            assertFalse(response.headers().firstValue("Last-Modified").isPresent(), path);
        }
    }

    @Test
    void aiAndSimulationApisStartTogetherInMockMode() throws Exception {
        var client = HttpClient.newHttpClient();
        var json = JsonMapper.builder().build();
        for (String path : List.of("/api/ai/status", "/api/device/status")) {
            var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).build();
            var response = client.send(request, HttpResponse.BodyHandlers.ofString());
            assertEquals(200, response.statusCode(), path);
            assertEquals("MOCK", json.readTree(response.body()).path("mode").asString(), path);
        }
    }
}
