package com.example.lensmind;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class LensmindApplication {

	public static void main(String[] args) {
		SpringApplication.run(LensmindApplication.class, args);
		System.out.println("Lensmind Application is running");
		System.out.println("please visit http://localhost:8080");
	}

}
