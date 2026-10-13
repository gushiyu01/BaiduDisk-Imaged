package com.zcode.picman.web;

import com.zcode.picman.service.TagService;
import com.zcode.picman.web.dto.Dtos.TagDto;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/tags")
public class TagController {

    private final TagService tags;

    public TagController(TagService tags) {
        this.tags = tags;
    }

    public record TagRequest(@NotBlank(message = "标签名不能为空") String name, String color) {
    }

    @GetMapping
    public List<TagDto> list() {
        return tags.list();
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public TagDto create(@Valid @RequestBody TagRequest request) {
        return tags.create(request.name(), request.color());
    }

    @PatchMapping("/{id}")
    public TagDto update(@PathVariable long id, @RequestBody TagRequest request) {
        return tags.update(id, request.name(), request.color());
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable long id) {
        tags.delete(id);
    }
}
