package com.example.lensmind.vision;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import javax.imageio.ImageIO;
import javax.imageio.stream.MemoryCacheImageInputStream;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/vision")
public class VisionController {
    private static final int MAX_BYTES = 256 * 1024;
    private static final int MAX_EDGE = 640;
    private final PersonDetector detector;
    private final FaceDetector faceDetector;
    private final PoseDetector poseDetector;

    VisionController(PersonDetector detector, FaceDetector faceDetector, PoseDetector poseDetector) {
        this.detector = detector;
        this.faceDetector = faceDetector;
        this.poseDetector = poseDetector;
    }

    @PostMapping(path = "/person", consumes = "image/jpeg")
    public FrameResult person(@RequestParam long frameId, @RequestParam long timestamp,
                              @RequestParam(defaultValue = "false") boolean head,
                              @RequestParam(defaultValue = "false") boolean pose,
                              HttpServletRequest request) throws IOException {
        if (frameId < 1 || timestamp < 1) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "帧编号和时间戳必须为正数。");
        }
        byte[] bytes = request.getInputStream().readNBytes(MAX_BYTES + 1);
        if (bytes.length > MAX_BYTES) {
            throw new ResponseStatusException(HttpStatus.CONTENT_TOO_LARGE, "JPEG 单帧最多 256 KiB。");
        }
        BufferedImage frame = readFrame(bytes);
        var people = detector.detect(frame);
        var primary = people.isEmpty() ? null : people.get(0);
        var faces = head ? faceDetector.detect(frame) : null;
        var poses = pose ? poseDetector.detect(frame, people) : null;
        return new FrameResult(frameId, timestamp, frame.getWidth(), frame.getHeight(), primary, people, faces, poses);
    }

    private static BufferedImage readFrame(byte[] bytes) {
        try (var input = new MemoryCacheImageInputStream(new ByteArrayInputStream(bytes))) {
            var readers = ImageIO.getImageReadersByFormatName("JPEG");
            var reader = readers.next();
            try {
                reader.setInput(input, true, true);
                if (reader.getWidth(0) > MAX_EDGE || reader.getHeight(0) > MAX_EDGE) {
                    throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "JPEG 最长边需在 640 像素以内。");
                }
                return reader.read(0);
            } finally {
                reader.dispose();
            }
        } catch (IOException error) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "无法读取 JPEG 图像。", error);
        }
    }

    @ExceptionHandler(ResponseStatusException.class)
    ResponseEntity<Map<String, String>> visionError(ResponseStatusException error) {
        return ResponseEntity.status(error.getStatusCode()).body(Map.of("message", error.getReason()));
    }

    record FrameResult(long frameId, long timestamp, int width, int height, PersonDetector.Person person,
                       List<PersonDetector.Person> people, List<FaceDetector.Face> faces, List<Map<String, PoseDetector.Point>> poses) {}
}
