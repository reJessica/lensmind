package com.example.lensmind.control;

import com.example.lensmind.control.DeviceGateway.DeviceFrame;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.Locale;
import java.util.UUID;

final class MockCamera {
    private static final int WIDTH = 1200;
    private static final int HEIGHT = 800;
    private static final int PIXELS_PER_STEP = 3;
    private static final String SCENE_CONTENT = loadSceneContent();

    private MockCamera() {}

    static DeviceFrame render(int x, int y) {
        // 向左移动相机时，固定场景向画面右侧偏移。
        int sceneX = -60 - x * PIXELS_PER_STEP;
        int sceneY = -40 + y * PIXELS_PER_STEP;
        String svg = """
                <svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">
                  <rect width="100%%" height="100%%" fill="#c8c9b9"/>
                  <svg x="%d" y="%d" width="1320" height="880" viewBox="0 0 %d %d">%s
                  </svg>
                </svg>
                """;
        svg = String.format(Locale.ROOT, svg, WIDTH, HEIGHT, WIDTH, HEIGHT, sceneX, sceneY, WIDTH, HEIGHT, SCENE_CONTENT);
        String encoded = Base64.getEncoder().encodeToString(svg.getBytes(StandardCharsets.UTF_8));
        return new DeviceFrame(UUID.randomUUID().toString(), Instant.now().toString(), WIDTH, HEIGHT,
                "data:image/svg+xml;base64," + encoded);
    }

    private static String loadSceneContent() {
        try (var file = MockCamera.class.getResourceAsStream("/static/assets/demo-scene.svg")) {
            if (file == null) throw new IllegalStateException("缺少模拟场景资源");
            String svg = new String(file.readAllBytes(), StandardCharsets.UTF_8);
            // 保留场景内部图形，外层 SVG 负责相机取景与画面边界。
            return svg.substring(svg.indexOf('>') + 1, svg.lastIndexOf("</svg>"));
        } catch (IOException error) {
            throw new UncheckedIOException("读取模拟场景失败", error);
        }
    }
}
