package com.example.lensmind.api;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Tracks an operator-led calibration. This controller never opens the serial port. */
@RestController
@RequestMapping("/api/device/calibration")
class So101CalibrationController {
    private static final List<String> JOINTS = List.of(
            "shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper");
    private static final int MAX_RECORD_BYTES = 65536;
    private final JsonMapper json = JsonMapper.builder().build();
    private final boolean required;
    private final Path file;
    private final String command;
    private final String wristCamera;
    private boolean started;
    private Stamp baseline;
    private Stamp verified;

    So101CalibrationController(
            @Value("${lensmind.calibration.required:false}") boolean required,
            @Value("${lensmind.calibration.port:}") String port,
            @Value("${lensmind.calibration.file:}") String output,
            @Value("${lensmind.calibration.python:python}") String python,
            @Value("${lensmind.calibration.resume-sha256:}") String resumeSha256,
            @Value("${lensmind.camera.wrist-label:}") String wristCamera) {
        this.required = required;
        this.wristCamera = wristCamera.trim();
        file = output.isBlank() ? null : Path.of(output).toAbsolutePath().normalize();
        command = file == null || port.isBlank() ? "" : command(python, port, file);
        if (required && !command.isEmpty() && !resumeSha256.isBlank()) {
            Stamp current = stamp();
            if (current != null && validRecord(resumeSha256) && current.equals(stamp())) verified = current;
        }
    }

    @GetMapping
    public synchronized Status status() {
        if (!required) return status("DISABLED", true, "");
        if (command.isEmpty()) return status("UNCONFIGURED", false, "请先配置 SO-101 串口和校准文件路径。");
        if (verified != null && verified.equals(stamp())) {
            return status("VERIFIED", true, "已核验本次校准记录。");
        }
        if (verified != null) {
            started = false;
            verified = null;
        }
        return started ? status("PENDING", false, "请在终端手动校准，完成后点击「核验结果」。")
                : status("REQUIRED", false, "请开始本次机械臂校准。");
    }

    @PostMapping("/start")
    public synchronized Status start() {
        if (!required || command.isEmpty()) return status();
        baseline = stamp();
        verified = null;
        started = true;
        return status();
    }

    @PostMapping("/verify")
    public synchronized Status verify() {
        if (!required || !started) return status();
        Stamp current = stamp();
        if (current == null || current.equals(baseline)) {
            return status("PENDING", false, "尚未找到本次新生成的校准记录。请等终端显示校准完成。");
        }
        if (!validRecord("") || !current.equals(stamp())) {
            return status("PENDING", false, "校准记录尚未写完或六轴数据无效，请检查终端。");
        }
        verified = current;
        return status();
    }

    private Status status(String phase, boolean ready, String message) {
        String revision = "VERIFIED".equals(phase) ? verified.modified() + "/" + verified.size() : "";
        return new Status(required, ready, phase, message, required ? command : "", revision, wristCamera);
    }

    private Stamp stamp() {
        try {
            var attributes = Files.readAttributes(file, BasicFileAttributes.class);
            return attributes.isRegularFile() ? new Stamp(attributes.lastModifiedTime(), attributes.size()) : null;
        } catch (IOException error) {
            return null;
        }
    }

    private boolean validRecord(String expectedSha256) {
        try (var input = Files.newInputStream(file)) {
            byte[] data = input.readNBytes(MAX_RECORD_BYTES + 1);
            if (data.length > MAX_RECORD_BYTES) return false;
            if (!expectedSha256.isEmpty() && !expectedSha256.equalsIgnoreCase(
                    HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data)))) return false;
            JsonNode root = json.readTree(data);
            if (root == null || !root.isObject() || root.size() != JOINTS.size()) return false;
            for (int i = 0; i < JOINTS.size(); i++) {
                JsonNode motor = root.path(JOINTS.get(i));
                int min = motor.path("range_min").asInt(-1);
                int max = motor.path("range_max").asInt(-1);
                if (motor.path("id").asInt(-1) != i + 1 || !motor.path("homing_offset").isIntegralNumber()
                        || !motor.path("range_min").isIntegralNumber() || !motor.path("range_max").isIntegralNumber()
                        || min < 0 || max > 4095 || min >= max) return false;
            }
            return true;
        } catch (IOException | NoSuchAlgorithmException | RuntimeException error) {
            return false;
        }
    }

    private static String command(String python, String port, Path output) {
        boolean windows = System.getProperty("os.name").toLowerCase(Locale.ROOT).startsWith("windows");
        Path script = Path.of("scripts", "calibrate_so101.py").toAbsolutePath().normalize();
        return (windows ? "& " : "") + quote(python, windows) + " " + quote(script.toString(), windows) + " --port "
                + quote(port, windows) + " --output " + quote(output.toString(), windows);
    }

    private static String quote(String value, boolean windows) {
        return "'" + value.replace("'", windows ? "''" : "'\"'\"'") + "'";
    }

    record Status(boolean required, boolean ready, String phase, String message, String command, String revision,
                  String wristCamera) {}
    private record Stamp(FileTime modified, long size) {}
}
