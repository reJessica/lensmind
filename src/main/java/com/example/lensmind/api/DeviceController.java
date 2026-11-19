package com.example.lensmind.api;

import com.example.lensmind.control.DeviceGateway;
import com.example.lensmind.control.DeviceGateway.DeviceStatus;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/device")
public class DeviceController {
    private final DeviceGateway device;

    public DeviceController(DeviceGateway device) {
        this.device = device;
    }

    @GetMapping("/status")
    public DeviceStatus status() { return device.status(); }

    @PostMapping("/move")
    public DeviceStatus move(@RequestBody MoveRequest request) {
        if (request == null || request.step() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "缺少步长 step");
        }
        return device.move(request.direction(), request.step());
    }

    @PostMapping("/home")
    public DeviceStatus home() { return device.home(); }

    @PostMapping("/stop")
    public DeviceStatus stop() { return device.stop(); }

    public record MoveRequest(String direction, Integer step) {}
}
