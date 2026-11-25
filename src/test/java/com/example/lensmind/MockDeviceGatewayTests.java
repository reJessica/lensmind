package com.example.lensmind;

import com.example.lensmind.control.DeviceGateway.DeviceFrame;
import com.example.lensmind.control.MockDeviceGateway;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;

import static org.junit.jupiter.api.Assertions.*;

class MockDeviceGatewayTests {
    @Test
    void leftMoveUpdatesTheFrameAndStopKeepsItFrozenUntilHome() {
        var device = new MockDeviceGateway();
        var initial = device.status().frame();
        var moved = device.move("LEFT", 1);
        assertEquals(-1, moved.x());
        assertEquals(0, moved.y());
        assertNotEquals(initial.id(), moved.frame().id());
        assertNotEquals(initial.src(), moved.frame().src());
        assertFalse(Instant.parse(moved.frame().timestamp()).isBefore(Instant.parse(initial.timestamp())));
        assertEquals(1200, moved.frame().width());
        assertEquals(800, moved.frame().height());
        assertTrue(decode(initial).contains("<svg x=\"-60\" y=\"-40\""));
        assertTrue(decode(moved.frame()).contains("<svg x=\"-57\" y=\"-40\""));

        var stopped = device.stop();
        assertEquals("STOPPED", stopped.state());
        assertEquals(moved.frame(), stopped.frame());
        var rejected = assertThrows(ResponseStatusException.class, () -> device.move("LEFT", 1));
        assertEquals(409, rejected.getStatusCode().value());
        assertEquals(stopped, device.status());

        var home = device.home();
        assertEquals(initial.src(), home.frame().src());
        assertNotEquals(initial.id(), home.frame().id());
        assertEquals(2, device.move("RIGHT", 2).x());
    }

    @Test
    void invalidMovesNeverChangePosition() {
        var device = new MockDeviceGateway();
        for (int i = 0; i < 4; i++) device.move("RIGHT", 5);
        var atBoundary = device.status();
        assertThrows(ResponseStatusException.class, () -> device.move("RIGHT", 1));
        assertThrows(ResponseStatusException.class, () -> device.move("UP", 6));
        assertThrows(ResponseStatusException.class, () -> device.move(null, 1));
        assertEquals(20, atBoundary.x());
        assertEquals(0, atBoundary.y());
        assertEquals(atBoundary, device.status());
    }

    private static String decode(DeviceFrame frame) {
        String prefix = "data:image/svg+xml;base64,";
        assertTrue(frame.src().startsWith(prefix));
        return new String(Base64.getDecoder().decode(frame.src().substring(prefix.length())), StandardCharsets.UTF_8);
    }
}
