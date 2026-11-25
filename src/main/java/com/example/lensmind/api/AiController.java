package com.example.lensmind.api;

import static com.example.lensmind.ai.AiContracts.*;
import com.example.lensmind.ai.AiException;
import com.example.lensmind.ai.AiService;
import java.io.IOException;
import java.util.Map;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

/** 所有 AI 接口只返回结果，不持有或调用 DeviceGateway。 */
@RestController
@RequestMapping("/api/ai")
public class AiController {
    private final AiService ai;
    public AiController(AiService ai) { this.ai = ai; }
    @GetMapping("/status") public Map<String, Object> status() { return ai.status(); }
    @PostMapping("/command") public Result<Command> command(@RequestBody CommandRequest request) { return ai.command(request); }
    @PostMapping(value = "/vision", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<FrameAnalysis> vision(@RequestPart("image") MultipartFile image,
                                       @RequestParam String frameId, @RequestParam String capturedAt,
                                       @RequestParam Composition composition, @RequestParam Framing framing) {
        return ai.vision(read(image, 4_000_000), frameId, capturedAt, composition, framing);
    }
    @PostMapping(value = "/asr", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<Transcript> asr(@RequestPart("audio") MultipartFile audio) { return ai.transcribe(read(audio, 3_000_000)); }
    @PostMapping("/tts") public ResponseEntity<byte[]> tts(@RequestBody SpeechRequest request) {
        Audio audio = ai.speak(request);
        return ResponseEntity.ok().contentType(MediaType.parseMediaType(audio.contentType()))
                .cacheControl(CacheControl.noStore()).header("X-LensMind-Mode", audio.mode())
                .header("X-LensMind-Audio", "MOCK".equals(audio.mode()) ? "tone-only" : "speech")
                .body(audio.bytes());
    }
    private byte[] read(MultipartFile file, long max) {
        if (file.isEmpty() || file.getSize() > max) throw AiException.badInput("文件为空或超过接口大小限制");
        try { return file.getBytes(); } catch (IOException e) { throw AiException.badInput("无法读取上传文件"); }
    }
}

@RestControllerAdvice(assignableTypes = AiController.class)
class AiErrorHandler {
    @ExceptionHandler(AiException.class)
    ResponseEntity<Map<String, String>> handle(AiException exception) {
        return ResponseEntity.status(exception.status()).body(Map.of("code", exception.code(), "message", exception.getMessage()));
    }
}
