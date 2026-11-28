package com.example.lensmind;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

@SpringBootApplication
public class LensmindApplication {

	public static void main(String[] args) {
		var application = new SpringApplication(LensmindApplication.class);
		application.setDefaultProperties(configFallback(LensmindApplication.class.getClassLoader(), Path.of(".")));
		application.run(args);
		System.out.println("Lensmind Application is running");
		System.out.println("please visit http://localhost:8080");
	}

    // IDEs can compile Java without copying resources. Packaged applications keep normal classpath loading.
    static Map<String, Object> configFallback(ClassLoader loader, Path project) {
        Path resources = project.resolve("src/main/resources").toAbsolutePath().normalize();
        if (loader.getResource("application.properties") == null && Files.isRegularFile(resources.resolve("application.properties"))) {
            return Map.of("spring.config.additional-location", "optional:" + resources.toUri());
        }
        return Map.of();
    }

}
