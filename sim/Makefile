# Host simulator for firmware/core.  Run from the project root:  make -C sim <target>
# (the root Makefile forwards `make sim`, `make sim-test`, ...).
ROOT    := $(abspath ..)
LVGL    := $(ROOT)/vendor/waveshare/01_Arduino_Libraries/lvgl9/lvgl
CORE    := $(ROOT)/firmware/core/src
OUT     := $(ROOT)/build/sim
OBJ     := $(OUT)/obj
PORT    ?= 8090
MOCK_PORT ?= 8788

CC      := clang
CXX     := clang++
DEFS    := -DLV_CONF_INCLUDE_SIMPLE
INCS    := -I$(ROOT)/firmware/lvgl_conf -I$(LVGL) -I$(CORE) -I$(ROOT)/sim/src -I$(ROOT)/sim/third_party/cpp-httplib
OPT     ?= -O1 -g
CFLAGS  := $(OPT) $(DEFS) $(INCS) -MMD -MP
CXXFLAGS:= $(OPT) -std=c++17 -Wall -Wextra -Wno-unused-parameter -Wno-missing-field-initializers $(DEFS) $(INCS) -MMD -MP
LDLIBS  := -lcurl -lz -lpthread -framework Security -framework CoreFoundation

LVGL_SRC := $(shell find $(LVGL)/src -name '*.c')
CORE_SRC := $(wildcard $(CORE)/*.cpp)
FONT_SRC := $(wildcard $(CORE)/fonts/*.c)
SIM_SRC  := $(wildcard $(ROOT)/sim/src/*.cpp)

LVGL_OBJ := $(patsubst $(LVGL)/%.c,$(OBJ)/lvgl/%.o,$(LVGL_SRC))
CORE_OBJ := $(patsubst $(CORE)/%.cpp,$(OBJ)/core/%.o,$(CORE_SRC)) $(patsubst $(CORE)/fonts/%.c,$(OBJ)/fonts/%.o,$(FONT_SRC))
SIM_OBJ  := $(patsubst $(ROOT)/sim/src/%.cpp,$(OBJ)/sim/%.o,$(SIM_SRC))
BIN      := $(OUT)/pvsim

.PHONY: all build run test mock clean
all: build
build: $(BIN)

$(BIN): $(LVGL_OBJ) $(CORE_OBJ) $(SIM_OBJ)
	$(CXX) $(OPT) -o $@ $^ $(LDLIBS)

$(OBJ)/lvgl/%.o: $(LVGL)/%.c
	@mkdir -p $(dir $@)
	@$(CC) $(CFLAGS) -w -c $< -o $@
$(OBJ)/fonts/%.o: $(CORE)/fonts/%.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@
$(OBJ)/core/%.o: $(CORE)/%.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -c $< -o $@
$(OBJ)/sim/%.o: $(ROOT)/sim/src/%.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -c $< -o $@

# Interactive: mock server + simulator + browser UI on http://localhost:$(PORT)
run: build
	@ROOT=$(ROOT) PORT=$(PORT) MOCK_PORT=$(MOCK_PORT) sh $(ROOT)/sim/run.sh

# Headless scenarios (starts its own mock on a spare port)
test: build
	@ROOT=$(ROOT) sh $(ROOT)/sim/test.sh $(SCENARIO)

mock:
	python3 $(ROOT)/sim/mock_server.py --port $(MOCK_PORT) --store $(OUT)/mock_store

clean:
	rm -rf $(OUT)

-include $(LVGL_OBJ:.o=.d) $(CORE_OBJ:.o=.d) $(SIM_OBJ:.o=.d)
