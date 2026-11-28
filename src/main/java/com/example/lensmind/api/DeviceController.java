package com.example.lensmind.api;

import com.example.lensmind.control.DeviceGateway;
import com.example.lensmind.control.DeviceGateway.DeviceStatus;
import com.example.lensmind.control.So101DeviceGateway;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/device")
public class DeviceController {
    private final DeviceGateway device;
    private final So101CalibrationController calibration;

    public DeviceController(DeviceGateway device, So101CalibrationController calibration) {
        this.device = device;
        this.calibration = calibration;
    }

    @GetMapping("/status")
    public DeviceStatus status() { return device.status(); }

    @PostMapping("/move")
    public DeviceStatus move(@RequestBody MoveRequest request) {
        if (request == null || request.step() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "缺少步长 step");
        }
        if (device instanceof So101DeviceGateway) {
            if (!"voice".equals(request.source())) {
                throw new ResponseStatusException(HttpStatus.FORBIDDEN, "SO-101 微调使用麦克风指令");
            }
            requireVerifiedCalibration();
        }
        return device.move(request.direction(), request.step());
    }

    @PostMapping(value = "/arm", consumes = MediaType.APPLICATION_JSON_VALUE)
    public DeviceStatus armAtNeutral() {
        if (!(device instanceof So101DeviceGateway so101)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "实机控制端尚未接入");
        }
        requireVerifiedCalibration();
        return so101.armAtNeutral();
    }

    @PostMapping("/home")
    public DeviceStatus home() { return device.home(); }

    @PostMapping("/stop")
    public DeviceStatus stop() { return device.stop(); }

    @PostMapping(value = "/release", consumes = MediaType.APPLICATION_JSON_VALUE)
    public DeviceStatus release(@RequestBody ReleaseRequest request) {
        if (!(device instanceof So101DeviceGateway so101)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "实机控制端尚未接入");
        }
        if (request == null || !Boolean.TRUE.equals(request.supported())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "请先确认已经托稳机械臂");
        }
        return so101.releaseTorque();
    }

    private void requireVerifiedCalibration() {
        var status = calibration.status();
        if (!"VERIFIED".equals(status.phase()) || status.wristCamera().isBlank()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "请先核验校准并配置腕部摄像头");
        }
    }

    public record MoveRequest(String direction, Integer step, String source) {}
    public record ReleaseRequest(Boolean supported) {}
}
