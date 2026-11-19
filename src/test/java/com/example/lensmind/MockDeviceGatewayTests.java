package com.example.lensmind;

import com.example.lensmind.control.MockDeviceGateway;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;
import static org.junit.jupiter.api.Assertions.*;

class MockDeviceGatewayTests {
    @Test
    void stopBlocksFurtherMovesUntilHome() {
        var device = new MockDeviceGateway();
        device.move("LEFT", 2);
        assertEquals("STOPPED", device.stop().state());
        assertThrows(ResponseStatusException.class, () -> device.move("RIGHT", 2));
        assertEquals(-2, device.status().x());
        device.home();
        assertEquals(2, device.move("RIGHT", 2).x());
    }

    @Test
    void invalidMovesNeverChangePosition() {
        var device = new MockDeviceGateway();
        for (int i = 0; i < 4; i++) device.move("RIGHT", 5);
        assertThrows(ResponseStatusException.class, () -> device.move("RIGHT", 1));
        assertThrows(ResponseStatusException.class, () -> device.move("UP", 6));
        assertThrows(ResponseStatusException.class, () -> device.move(null, 1));
        assertEquals(20, device.status().x());
        assertEquals(0, device.status().y());
    }
}
