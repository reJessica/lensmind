package com.example.lensmind.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.json.JsonMapper;

class So101CalibrationControllerTests {
    @TempDir Path directory;

    @Test
    void requiresFreshCompleteRecordAndInvalidatesIfRemoved() throws Exception {
        Path file = directory.resolve("class_so101.json");
        var controller = new So101CalibrationController(true, "COM9", file.toString(), "python", "", "");
        assertEquals("REQUIRED", controller.status().phase());
        assertFalse(controller.verify().ready());

        var record = JsonMapper.builder().build().createObjectNode();
        int id = 0;
        for (String joint : List.of("shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper")) {
            record.putObject(joint).put("id", ++id).put("homing_offset", 0)
                    .put("range_min", 500).put("range_max", 3500);
        }
        Files.writeString(file, record.toString());
        Files.setLastModifiedTime(file, FileTime.fromMillis(10000));
        assertEquals("PENDING", controller.start().phase());
        assertFalse(controller.verify().ready());
        Files.writeString(file, "{}");
        assertFalse(controller.verify().ready());
        Files.writeString(file, record.toString());
        assertEquals("VERIFIED", controller.verify().phase());
        assertFalse(controller.status().revision().isBlank());
        String hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(file)));
        assertTrue(new So101CalibrationController(true, "COM9", file.toString(), "python", hash, "").status().ready());
        assertFalse(new So101CalibrationController(true, "COM9", file.toString(), "python", "invalid", "").status().ready());
        Files.delete(file);
        assertFalse(controller.status().ready());
    }

    @Test
    void optionalCalibrationDoesNotBlockShooting() {
        var controller = new So101CalibrationController(false, "", "", "python", "", "");
        assertTrue(controller.status().ready());
        assertTrue(controller.start().ready());
    }
}
