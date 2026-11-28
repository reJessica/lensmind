package com.example.lensmind;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.SpringApplication;
import java.nio.file.Files;
import java.nio.file.Path;
import static org.junit.jupiter.api.Assertions.*;

class StartupConfigTests {
    @Test void missingCompiledResourceUsesExistingSourceDirectory(@TempDir Path root) throws Exception {
        Path resources = root.resolve("src/main/resources");
        Files.createDirectories(resources); Files.writeString(resources.resolve("application.properties"), "spring.application.name=test\n");
        var result = LensmindApplication.configFallback(new ClassLoader(null) {}, root);
        assertEquals("optional:" + resources.toUri(), result.get("spring.config.additional-location"));
    }

    @Test void normalClasspathAndPackagedLaunchDoNotAddSourceOverrides(@TempDir Path root) {
        assertTrue(LensmindApplication.configFallback(getClass().getClassLoader(), Path.of(".")).isEmpty());
        assertTrue(LensmindApplication.configFallback(new ClassLoader(null) {}, root).isEmpty());
    }

    @Test void sourceFallbackBootstrapsModelBeansWithoutPrimaryConfig(@TempDir Path empty) {
        var app = new SpringApplication(LensmindApplication.class);
        app.setDefaultProperties(LensmindApplication.configFallback(new ClassLoader(null) {}, Path.of(".")));
        try (var context = app.run("--spring.config.location=optional:" + empty.toUri(), "--server.port=0",
                "--lensmind.device.backend=mock", "--lensmind.ai.mode=MOCK", "--lensmind.local-asr.auto-start=false")) {
            assertNotNull(context.getBean("photographyAiController"));
            String hosts = context.getEnvironment().getProperty("lensmind.ai.allowed-hosts");
            assertNotNull(hosts); assertTrue(hosts.contains("zgc.apihy.com")); assertTrue(hosts.contains("api.uniapi.io"));
        }
    }
}
